// reuse-before-build — do not reinvent the wheel. A write that creates a tool/helper, or a
// delegation asking to build one, must carry evidence the wheel was checked: an audit
// phrase, the tool's basename already recorded in the project's tool map, or an installed
// dependency of the same name. What counts as a tool and as evidence is shared with
// tool-map (lib/tools.mjs) so the read and write halves of the pair cannot drift apart.
// The gate never reaches the network: the cloud search is the assistant's job.

import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import {
  AUDIT_DONE_PATTERN,
  DEFAULT_TOOL_EXTENSIONS,
  DEFAULT_TOOL_FOLDERS,
  DEFAULT_TOOL_NAME_PATTERNS,
  hasAuditEvidence,
  isNewToolIntent,
  isToolPath,
} from '../../lib/tools.mjs';

const GATE_ID = 'reuse-before-build';
const CONFIG_KEY = 'requireReuseCheckBeforeBuilding';

const DEFAULT_TOOL_MAP_FILE = join('.ai', 'tool-map.json');
const AUDIT_DONE_EXAMPLE_PHRASE = 'no existing tool covers this';

// A configured map path that escapes the project root is ignored in favor of the default:
// the map is project state, never a file elsewhere on the machine.
function toolMapPathFor(root, toolMapFile) {
  const resolved = resolve(root, String(toolMapFile || DEFAULT_TOOL_MAP_FILE));
  const relativePath = relative(root, resolved);
  const inside =
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath);
  return inside ? resolved : join(root, DEFAULT_TOOL_MAP_FILE);
}

function stemOf(path) {
  return basename(String(path ?? ''))
    .replace(/\.[^.]+$/, '')
    .toLowerCase();
}

function toolAlreadyInMap(root, toolMapFile, toolBaseName) {
  const parsed = readJsonOrNull(toolMapPathFor(root, toolMapFile));
  if (!Array.isArray(parsed?.tools)) return false;
  return parsed.tools.some((tool) => stemOf(tool?.path) === toolBaseName);
}

function installedDependencyCovers(root, toolBaseName) {
  const parsed = readJsonOrNull(join(root, 'package.json'));
  const names = [];
  for (const field of ['dependencies', 'devDependencies']) {
    const block = parsed?.[field];
    if (block && typeof block === 'object') names.push(...Object.keys(block));
  }
  return names.some(
    (name) => name.replace(/^@[^/]+\//, '').toLowerCase() === toolBaseName,
  );
}

function writeDenyMessage(filePath) {
  return (
    `Blocked: '${filePath}' looks like a new tool/helper, and nothing shows the wheel was ` +
    'checked first. Pick ONE, then retry the exact same write:\n' +
    `  1. It already exists here or in an installed dep — don't create '${filePath}'; ` +
    'reuse/import the existing one instead.\n' +
    '  2. It does not exist anywhere you checked (repo, installed deps, npm/marketplaces) — ' +
    "add ONE line to the file's content stating that, e.g.: " +
    `"// ${AUDIT_DONE_EXAMPLE_PHRASE}" (any phrase matching /${AUDIT_DONE_PATTERN.source}/iu ` +
    'works, this one is guaranteed to). That line also gets this file auto-recorded into ' +
    'the tool map — nothing further to run.\n' +
    'No filesystem exploration is required to satisfy this gate — the audit is a sentence ' +
    'in the file or a matching package.json dependency, nothing else.'
  );
}

function delegationDenyMessage() {
  return (
    "Blocked: this delegation's prompt asks to build a new tool/helper, and nothing in " +
    'the prompt shows the wheel was checked first. Pick ONE, then relaunch the same ' +
    'delegation with the prompt updated:\n' +
    '  1. It already exists (repo, installed dep) — do not delegate a new build; ' +
    'reference the existing one in the prompt instead.\n' +
    '  2. It does not exist anywhere you checked — add ONE line to the prompt stating ' +
    `that, e.g.: "${AUDIT_DONE_EXAMPLE_PHRASE}" (any phrase matching ` +
    `/${AUDIT_DONE_PATTERN.source}/iu works, this one is guaranteed to). Once the delegate ` +
    'actually writes the file, include the same phrase in its content so it also gets ' +
    'auto-recorded into the tool map.\n' +
    'No filesystem exploration is required to satisfy this gate — the audit is a sentence ' +
    'in the prompt, or a matching package.json dependency, nothing else.'
  );
}

function buildIsCleared(text, root, parameters, toolBaseName) {
  if (hasAuditEvidence(text)) return true;
  if (!toolBaseName) return false;
  return (
    toolAlreadyInMap(root, parameters.toolMapFile, toolBaseName) ||
    installedDependencyCovers(root, toolBaseName)
  );
}

function checkDelegation(toolInput, root, parameters) {
  const prompt = delegationPromptOf(toolInput);
  if (!isNewToolIntent(prompt)) return;
  if (buildIsCleared(prompt, root, parameters, null)) return;
  deny(CONFIG_KEY, delegationDenyMessage());
}

function checkWrite(toolInput, root, parameters) {
  const rawPath = writtenPathOf(toolInput);
  const filePath = rawPath.replace(/\\/g, '/');
  const isTool = isToolPath(filePath, {
    folders: parameters.toolFolders,
    extensions: parameters.toolExtensions,
    namePatterns: parameters.toolNamePatterns,
  });
  if (!isTool) return;
  if (existsSync(isAbsolute(rawPath) ? rawPath : join(root, rawPath))) return;
  const content = writtenContentOf(toolInput);
  if (buildIsCleared(content, root, parameters, stemOf(filePath))) return;
  deny(CONFIG_KEY, writeDenyMessage(filePath));
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      toolMapFile: DEFAULT_TOOL_MAP_FILE,
      toolFolders: DEFAULT_TOOL_FOLDERS,
      toolNamePatterns: DEFAULT_TOOL_NAME_PATTERNS,
      toolExtensions: DEFAULT_TOOL_EXTENSIONS,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    const root = projectRootOf(cwd) ?? cwd;
    if (toolInGroups(toolName, ['delegation'])) {
      checkDelegation(toolInput, root, parameters);
    } else if (toolInGroups(toolName, ['write'])) {
      checkWrite(toolInput, root, parameters);
    }
  },
);
