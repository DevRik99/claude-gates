// reuse-before-build — do not reinvent the wheel. Before building a new script, gate,
// verifier or generic helper, consult the per-project tool map: a record of what already
// solves a given need, local first, cloud second. This gate is the deterministic half —
// it consults the map and objects when a build is starting without evidence of a check.
// It never reaches the network: the cloud search (npm, marketplaces) is done by the
// assistant or the `claude-gates tool-map` CLI, so the hook stays self-contained.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   toolMapFile   path to the per-project tool map, relative to the project root.
//                 Default .ai/tool-map.json.
//
// ── How it decides (deterministic, no judgment) ─────────────────────────────────────
// A write that creates an executable tool (by extension) inside a tools folder, or a
// delegation prompt that asks to build one, must carry evidence that the wheel was
// checked: either an audit phrase in the text, or the need already recorded in the tool
// map. Absent both, the gate blocks with an actionable message — consult the map, then
// (if truly absent) search local→cloud and record the result with the CLI.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'reuse-before-build';
const CONFIG_KEY = 'requireReuseCheckBeforeBuilding';

const WRITE_TOOLS = new Set(TOOL_GROUPS.write);
const DELEGATION_TOOLS = new Set(TOOL_GROUPS.delegation);

const DEFAULT_TOOL_MAP_FILE = join('.ai', 'tool-map.json');
const EXECUTABLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.py',
  '.sh',
  '.ps1',
]);
const TOOL_FOLDERS = ['scripts/', 'hooks/', 'tools/', 'gates/'];
// A map word must be this long to count as a real signal (skip "the", "csv" is 3 but rare).
const MIN_SIGNIFICANT_WORD_LENGTH = 4;

// A verb of creation next to a tool noun. Deliberately narrow: "write a report" or
// "create a folder" do not match because the noun is not one of these.
const BUILD_INTENT_PATTERN =
  /\b(write|create|build|implement|add)\s+(a |the )?(new )?(script|verifier|gate|hook|linter|checker|tool)\b/i;
// Evidence the wheel was already checked: any phrase stating the audit result.
const AUDIT_DONE_PATTERN =
  /(already exists|no existing tool|there is no plugin|audited|checked whether|nothing does this|justification:)/i;

function projectRootOf(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Whether the tool map already records a need matching the given text. The map is a JSON
 * blob; a cheap lowercased contains-check over the significant words of the build target
 * is enough — the gate does not parse the map's shape, so the CLI is free to evolve it.
 * A word of 4+ chars found in the map counts as "this need is already tracked".
 */
function needRecordedInMap(startDirectory, toolMapFile, targetText) {
  const root = projectRootOf(startDirectory);
  if (!root) return false;
  const path = join(root, toolMapFile);
  if (!existsSync(path)) return false;
  let map;
  try {
    map = readFileSync(path, 'utf8').toLowerCase();
  } catch {
    return false;
  }
  const words = targetText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_SIGNIFICANT_WORD_LENGTH);
  return words.some((word) => map.includes(word));
}

function isExecutableToolPath(filePath) {
  const inToolFolder = TOOL_FOLDERS.some((folder) =>
    filePath.replace(/\\/g, '/').includes(folder),
  );
  return (
    inToolFolder && EXECUTABLE_EXTENSIONS.has(extname(filePath).toLowerCase())
  );
}

const DENY_MESSAGE =
  'Do not reinvent the wheel. Before building this, consult the project tool map and ' +
  'confirm nothing already covers it, auditing in this order: (1) LOCAL — the repo and ' +
  'installed deps (search by name and usage, read the manifest); (2) CONTEXT7 — resolve ' +
  'the candidate library and read its docs to confirm whether it truly covers the need; ' +
  '(3) WEB — search npm and plugin marketplaces for a maintained package. If it is ' +
  'genuinely absent, record the finding (e.g. `claude-gates tool-map add`) and state the ' +
  'audit in the text, so the exploration is not repeated next time.';

/** A build is allowed when its text declares an audit or the need is already in the map. */
function buildIsCleared(text, cwd, toolMapFile) {
  return (
    AUDIT_DONE_PATTERN.test(text) || needRecordedInMap(cwd, toolMapFile, text)
  );
}

/** Delegation: block a build-a-tool prompt that is not cleared. */
function checkDelegation(toolInput, cwd, toolMapFile) {
  const prompt = String(toolInput.prompt ?? toolInput.description ?? '');
  if (!BUILD_INTENT_PATTERN.test(prompt)) return;
  if (buildIsCleared(prompt, cwd, toolMapFile)) return;
  deny(GATE_ID, DENY_MESSAGE);
}

/** Write: block a new executable tool that is not cleared by its content or the map. */
function checkWrite(toolInput, cwd, toolMapFile) {
  const rawPath = String(
    toolInput.file_path ?? toolInput.target_file ?? toolInput.path ?? '',
  );
  const filePath = rawPath.replace(/\\/g, '/');
  if (!isExecutableToolPath(filePath)) return;
  // Editing an EXISTING file is not building a new tool — only creation triggers the audit.
  // A file already on disk is an edit, so it is allowed (lets the gates maintain themselves).
  if (rawPath && existsSync(rawPath)) return;
  const content = String(toolInput.content ?? toolInput.CodeContent ?? '');
  if (AUDIT_DONE_PATTERN.test(content)) return;
  if (needRecordedInMap(cwd, toolMapFile, filePath)) return;
  deny(GATE_ID, DENY_MESSAGE);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: { toolMapFile: DEFAULT_TOOL_MAP_FILE },
  },
  ({ toolName, toolInput, parameters }) => {
    const toolMapFile = parameters.toolMapFile ?? DEFAULT_TOOL_MAP_FILE;
    const cwd = process.cwd();
    if (DELEGATION_TOOLS.has(toolName)) {
      checkDelegation(toolInput, cwd, toolMapFile);
    } else if (WRITE_TOOLS.has(toolName)) {
      checkWrite(toolInput, cwd, toolMapFile);
    }
  },
);
