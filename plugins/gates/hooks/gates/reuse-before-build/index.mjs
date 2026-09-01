// reuse-before-build — do not reinvent the wheel. Before building a new script, gate,
// verifier, helper, composable, component or generic utility, consult what already solves
// the need: the per-project tool map (a record of past findings), the installed dependencies
// (package.json), and — declared by the author — a local→cloud audit. This gate is the
// deterministic half: it objects when a build is starting without evidence of a check.
// It never reaches the network: the cloud search (npm, marketplaces) is the assistant's or
// the CLI's job, so the hook stays self-contained.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   toolMapFile     path to the per-project tool map, relative to the project root.
//                   Default .ai/tool-map.json.
//   toolFolders     folder names that mark a file as a "tool/helper". Replaces the built-in
//                   list wholesale.
//   toolNamePatterns regex sources; a new file whose BASENAME matches any is treated as a
//                   generic helper regardless of its folder (useFoo, fooHelper, fooUtil...).
//   toolExtensions  file extensions considered code that can reinvent a wheel.
//
// ── How it decides (deterministic, no judgment) ─────────────────────────────────────
// A write that creates a tool/helper (by folder, by name pattern, or by a helper-ish
// extension), or a delegation prompt that asks to build one, must carry evidence the wheel
// was checked: (a) an audit phrase in the text, OR (b) the tool's own name already recorded
// in the tool map, OR (c) an installed dependency whose name matches the tool's name (there
// is already a package that plausibly covers it — reuse it or justify not to). Absent all
// three, the gate blocks with an actionable message.
//
// ── What changed vs the first version (closed holes) ────────────────────────────────
//   · Map match was a lax "any 4+-letter word of the target appears anywhere in the JSON",
//     which produced false "already covered" (a `parser.mjs` cleared by any unrelated entry
//     mentioning "parser"). Now it matches the tool's own basename as a whole token against
//     the recorded tool paths — structural, not substring-of-prose.
//   · Scope was only scripts/hooks/tools/gates + executable extensions. Now it also covers
//     lib/utils/helpers/composables/components/services AND name patterns (useX, XHelper,
//     XUtil, XService) anywhere, which is where a wheel is most often reinvented.
//   · Build-intent detection was English-only prose; now it uses the bilingual BUILD_INTENT.
//   · Adds an installed-dependency check: a matching package.json dep also clears the build.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  runGate,
  deny,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { isBuildIntent } from '../../lib/signals.mjs';

const GATE_ID = 'reuse-before-build';
const CONFIG_KEY = 'requireReuseCheckBeforeBuilding';

const DEFAULT_TOOL_MAP_FILE = join('.ai', 'tool-map.json');

// Code that can reinvent a wheel — broad, because a helper is a helper in any language.
const DEFAULT_TOOL_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.py',
  '.sh',
  '.ps1',
  '.rb',
  '.go',
];

// Folders whose files are "tools/helpers" worth a reuse check. Beyond the original four,
// this now includes the places generic reusable code actually lives.
const DEFAULT_TOOL_FOLDERS = [
  'scripts',
  'hooks',
  'tools',
  'gates',
  'lib',
  'libs',
  'utils',
  'util',
  'helpers',
  'helper',
  'composables',
  'components',
  'services',
  'shared',
  'common',
];

// A file whose BASENAME matches one of these is a generic helper wherever it lives —
// useDebounce.ts in features/x/ is still a candidate for "does this already exist?".
const DEFAULT_TOOL_NAME_PATTERNS = [
  String.raw`^use[A-Z]`, // React/Vue hook/composable: useFoo
  String.raw`[-.]?helpers?\.`, // foo.helper.ts, foo-helpers.js
  String.raw`[-.]?utils?\.`, // foo.util.ts, string-utils.js
  String.raw`[-.]?service\.`, // foo.service.ts
  String.raw`[-.]?wrapper\.`, // foo.wrapper.ts
];

// Evidence the wheel was already checked: any phrase stating the audit result. Bilingual.
const AUDIT_DONE_PATTERN =
  /(already exists|no existing tool|there is no plugin|audited|checked whether|nothing does this|justification:|ya existe|no existe (?:una |la )?herramienta|no hay plugin|audit[eé]|verifiqu[eé] que no)/i;

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
 * Whether the tool map already records THIS tool, matched structurally: the new file's
 * basename (without extension) is compared as a whole `-`/`.`-delimited token against the
 * basenames of the recorded tool paths. This replaces the old "any 4+-letter word appears
 * anywhere in the JSON blob", which cleared unrelated builds by coincidental word overlap.
 */
function toolAlreadyInMap(startDirectory, toolMapFile, toolBaseName) {
  const root = projectRootOf(startDirectory);
  if (!root) return false;
  const path = join(root, toolMapFile);
  if (!existsSync(path)) return false;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  if (!Array.isArray(parsed.tools)) return false;
  const target = toolBaseName.toLowerCase();
  return parsed.tools.some((tool) => {
    const recorded = basename(String(tool.path ?? ''))
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
    return recorded === target;
  });
}

/** Whether an installed dependency's name matches the tool's name (a package likely covers
 * it). Normalizes scoped names (@scope/foo → foo) and matches whole, so `parser` is cleared
 * by a `parser`/`@x/parser` dep but not by an unrelated `body-parser`. */
function installedDependencyCovers(startDirectory, toolBaseName) {
  const root = projectRootOf(startDirectory);
  if (!root) return false;
  const path = join(root, 'package.json');
  if (!existsSync(path)) return false;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  const names = [
    ...Object.keys(parsed.dependencies ?? {}),
    ...Object.keys(parsed.devDependencies ?? {}),
  ];
  const target = toolBaseName.toLowerCase();
  return names.some((name) => {
    const bare = name.replace(/^@[^/]+\//, '').toLowerCase();
    return bare === target;
  });
}

function hasToolExtension(filePath, toolExtensions) {
  return toolExtensions.includes(extname(filePath).toLowerCase());
}

/** A real path SEGMENT equal to one of the tool-folder names (not a mere substring, so
 * `src/mytools/x` does not match `tools`). */
function inToolFolder(filePath, toolFolders) {
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments.some((segment) =>
    toolFolders.includes(segment.toLowerCase()),
  );
}

function matchesToolNamePattern(fileName, toolNamePatterns) {
  return toolNamePatterns.some((source) => {
    try {
      return new RegExp(source).test(fileName);
    } catch {
      return false;
    }
  });
}

/** Whether a new file at this path should be treated as a reusable tool/helper. */
function isToolLikePath(filePath, parameters) {
  if (!hasToolExtension(filePath, parameters.toolExtensions)) return false;
  const fileName = basename(filePath);
  return (
    inToolFolder(filePath, parameters.toolFolders) ||
    matchesToolNamePattern(fileName, parameters.toolNamePatterns)
  );
}

// The exact phrase AUDIT_DONE_PATTERN matches — quoted verbatim in the deny message so the
// model can copy it instead of guessing a paraphrase the regex might not recognize (a vague
// "I checked" or "no lo encontré" does NOT match AUDIT_DONE_PATTERN and the gate fires again).
const AUDIT_DONE_EXAMPLE_PHRASE = 'no existing tool covers this';

/** The concrete deny message for a blocked WRITE: names the exact file and gives the exact
 * text to add (copy-pasteable, matches AUDIT_DONE_PATTERN verbatim) — no exploration needed
 * to find any of this, it is the gate's own job to hand it over. Adding the phrase also
 * satisfies the tool-map gate (maintainToolMap), which records the file + this same line
 * into .ai/tool-map.json automatically — no separate command to run. */
function writeDenyMessage(filePath) {
  return (
    `Blocked: '${filePath}' looks like a new tool/helper, and nothing shows the wheel was ` +
    'checked first. Pick ONE, then retry the exact same write:\n' +
    `  1. It already exists here or in an installed dep — don't create '${filePath}'; ` +
    'reuse/import the existing one instead.\n' +
    '  2. It does not exist anywhere you checked (repo, installed deps, npm/marketplaces) — ' +
    "add ONE line to the file's content stating that, e.g.: " +
    `"// ${AUDIT_DONE_EXAMPLE_PHRASE}" (any phrase matching /${AUDIT_DONE_PATTERN.source}/i ` +
    'works, this one is guaranteed to). That line also gets this file auto-recorded into ' +
    '.ai/tool-map.json — nothing further to run.\n' +
    'No filesystem exploration is required to satisfy this gate — the audit is a sentence ' +
    'in the file or a matching package.json dependency, nothing else.'
  );
}

/** The concrete deny message for a blocked DELEGATION prompt: same two options, but no file
 * name exists yet (only a prompt), so both talk about the prompt text, not a file. */
function delegationDenyMessage() {
  return (
    "Blocked: this delegation's prompt asks to build a new tool/helper, and nothing in " +
    'the prompt shows the wheel was checked first. Pick ONE, then relaunch the same ' +
    'delegation with the prompt updated:\n' +
    '  1. It already exists (repo, installed dep) — do not delegate a new build; ' +
    'reference the existing one in the prompt instead.\n' +
    '  2. It does not exist anywhere you checked — add ONE line to the prompt stating ' +
    `that, e.g.: "${AUDIT_DONE_EXAMPLE_PHRASE}" (any phrase matching ` +
    `/${AUDIT_DONE_PATTERN.source}/i works, this one is guaranteed to). Once the delegate ` +
    'actually writes the file, include the same phrase in its content so it also gets ' +
    'auto-recorded into .ai/tool-map.json.\n' +
    'No filesystem exploration is required to satisfy this gate — the audit is a sentence ' +
    'in the prompt, or a matching package.json dependency, nothing else.'
  );
}

/** A build is cleared when its text declares an audit, its name is already recorded in the
 * map, or an installed dependency covers it. `toolBaseName` is used for the last two. */
function buildIsCleared(text, cwd, parameters, toolBaseName) {
  if (AUDIT_DONE_PATTERN.test(text)) return true;
  if (
    toolBaseName &&
    toolAlreadyInMap(cwd, parameters.toolMapFile, toolBaseName)
  )
    return true;
  if (toolBaseName && installedDependencyCovers(cwd, toolBaseName)) return true;
  return false;
}

/** Delegation: block a build-a-tool prompt that is not cleared. No file name is known from a
 * prompt, so only the audit-phrase evidence applies there. */
function checkDelegation(toolInput, cwd, parameters) {
  const prompt = delegationPromptOf(toolInput);
  if (!isBuildIntent(prompt)) return;
  if (buildIsCleared(prompt, cwd, parameters, null)) return;
  deny(CONFIG_KEY, delegationDenyMessage());
}

/** Write: block a new tool-like file that is not cleared by content, map, or an installed dep. */
function checkWrite(toolInput, cwd, parameters) {
  const rawPath = writtenPathOf(toolInput);
  const filePath = rawPath.replace(/\\/g, '/');
  if (!isToolLikePath(filePath, parameters)) return;
  // Editing an EXISTING file is not building a new tool — only creation triggers the audit.
  if (rawPath && existsSync(rawPath)) return;
  const content = writtenContentOf(toolInput);
  const toolBaseName = basename(filePath).replace(/\.[^.]+$/, '');
  if (buildIsCleared(content, cwd, parameters, toolBaseName)) return;
  deny(CONFIG_KEY, writeDenyMessage(filePath));
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      toolMapFile: DEFAULT_TOOL_MAP_FILE,
      toolFolders: DEFAULT_TOOL_FOLDERS,
      toolNamePatterns: DEFAULT_TOOL_NAME_PATTERNS,
      toolExtensions: DEFAULT_TOOL_EXTENSIONS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const cwd = process.cwd();
    if (toolInGroups(toolName, ['delegation'])) {
      checkDelegation(toolInput, cwd, parameters);
    } else if (toolInGroups(toolName, ['write'])) {
      checkWrite(toolInput, cwd, parameters);
    }
  },
);
