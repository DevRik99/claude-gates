// tool-map — maintains the per-project tool map so a discovery is never repeated. It is
// the write half of the discovery pair (reuse-before-build is the read half). When a new
// tool is created WITH its audit declared, this gate records what that tool covers into
// .ai/tool-map.json, so next time reuse-before-build finds it and does not block.
//
// It never reaches the network and takes no judgment: it only appends a deterministic
// record (path + the audit line the author already wrote) to a JSON file. The cloud search
// that decides "does something already exist?" is the assistant's / the CLI's job. This
// gate never denies — it observes a legitimate build and remembers it. It warns once when
// it could not record, so a silent write failure does not go unnoticed.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   toolMapFile   path to the per-project tool map, relative to the project root.
//                 Default .ai/tool-map.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { runGate, warn, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'tool-map';
const CONFIG_KEY = 'maintainToolMap';

const WRITE_TOOLS = new Set(TOOL_GROUPS.write);
const DEFAULT_TOOL_MAP_FILE = join('.ai', 'tool-map.json');
const JSON_INDENT = 2;
const MAX_AUDIT_LENGTH = 300;

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

// Phrases that mark a line as the author's audit statement. Matched against one line at a
// time (no wrapping `.*`, which backtracks): the matching line is captured whole.
const AUDIT_PHRASE_PATTERN =
  /(already exists|no existing tool|there is no plugin|audited|nothing does this|justification:)/i;

/** The first line of `content` that states an audit, trimmed — or null when none does. */
function auditLineOf(content) {
  for (const line of content.split('\n')) {
    if (AUDIT_PHRASE_PATTERN.test(line)) return line.trim();
  }
  return null;
}

function projectRootOf(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isExecutableToolPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const inToolFolder = TOOL_FOLDERS.some((folder) =>
    normalized.includes(folder),
  );
  return (
    inToolFolder && EXECUTABLE_EXTENSIONS.has(extname(filePath).toLowerCase())
  );
}

function readMap(path) {
  if (!existsSync(path)) return { tools: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed.tools) ? parsed : { tools: [] };
  } catch {
    return { tools: [] };
  }
}

/** Appends the tool's record to the map file, warning (never blocking) if it cannot. */
function recordTool(mapPath, normalizedPath, auditLine, toolMapFile) {
  const map = readMap(mapPath);
  if (map.tools.some((tool) => tool.path === normalizedPath)) return; // already recorded

  map.tools.push({
    path: normalizedPath,
    audit: auditLine.slice(0, MAX_AUDIT_LENGTH),
    recordedAt: new Date().toISOString(),
  });

  try {
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(
      mapPath,
      `${JSON.stringify(map, null, JSON_INDENT)}\n`,
      'utf8',
    );
  } catch (error) {
    warn(
      GATE_ID,
      `Could not record this tool in ${toolMapFile}: ${error?.message ?? error}. ` +
        'The build proceeds, but the discovery was not remembered.',
    );
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: { toolMapFile: DEFAULT_TOOL_MAP_FILE },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!WRITE_TOOLS.has(toolName)) return;

    const filePath = String(
      toolInput.file_path ?? toolInput.target_file ?? toolInput.path ?? '',
    );
    if (!isExecutableToolPath(filePath)) return;

    // Only a build that declared its audit is worth recording: that line IS the reason
    // this tool exists and what it was checked against.
    const content = String(toolInput.content ?? toolInput.CodeContent ?? '');
    const auditLine = auditLineOf(content);
    if (!auditLine) return;

    const root = projectRootOf(process.cwd());
    if (!root) return;
    const toolMapFile = parameters.toolMapFile ?? DEFAULT_TOOL_MAP_FILE;
    recordTool(
      join(root, toolMapFile),
      filePath.replace(/\\/g, '/'),
      auditLine,
      toolMapFile,
    );
  },
);
