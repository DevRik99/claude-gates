// audit-before-build — creating a new executable tool (a file under a tool folder, or a
// delegation asking to build one) must state that existing tools were audited. Editing an
// existing file is never a build; the exemption is what lets the gates maintain themselves.

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  writtenPathOf,
  writtenContentOf,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { isBuildIntent } from '../../lib/signals.mjs';
import {
  AUDIT_DONE_PATTERN,
  hasAuditEvidence,
  isToolPath,
} from '../../lib/tools.mjs';

const GATE_ID = 'audit-before-build';
const CONFIG_KEY = 'requireAuditBeforeBuilding';

const DEFAULT_EXECUTABLE_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.py',
  '.sh',
  '.ps1',
];
const DEFAULT_TOOL_FOLDERS = ['scripts', 'hooks', 'tools'];
// Vendored or VCS-internal trees are never the project's own new tool.
const FOREIGN_SEGMENTS = new Set(['.git', 'node_modules']);
const AUDIT_EXAMPLE_PHRASE = 'no existing tool covers this';

// "the build script" is a noun phrase, and "add tests for the gate" builds a test, not a
// gate; both would otherwise read as creation verb + tool noun.
const BUILD_AS_NOUN_PATTERN =
  /\b(?:the|a|an|this|that|our|your|my|el|la|un|una|este|esta)\s+build\b/giu;
const CREATION_VERBS = [
  'write',
  'create',
  'build',
  'implement',
  'add',
  'make',
  'escribe',
  'escribi',
  'escribir',
  'crea',
  'construye',
  'construir',
  'implementa',
  'implementar',
  'agrega',
  'arma',
  'hace',
  'genera',
  'generar',
  'armá',
  'hacé',
  'creá',
  'agregá',
  'generá',
  'escribí',
  'construí',
];
const OBJECT_QUALIFIERS =
  'a|the|some|new|more|unos|unas|los|las|más|nuevos|nuevas';
const TEST_OBJECT_NOUNS = 'tests?|specs?|pruebas?';
const TEST_OBJECT_PATTERN = new RegExp(
  String.raw`\b(?:${CREATION_VERBS.join('|')})\s+(?:(?:${OBJECT_QUALIFIERS})\s+){0,2}(?:${TEST_OBJECT_NOUNS})\b`,
  'giu',
);

function hasNewToolIntent(prompt) {
  const masked = prompt
    .replace(BUILD_AS_NOUN_PATTERN, 'it')
    .replace(TEST_OBJECT_PATTERN, 'tests');
  return isBuildIntent(masked);
}

function checkDelegation(toolInput) {
  const prompt = delegationPromptOf(toolInput);
  if (!hasNewToolIntent(prompt)) return;
  if (hasAuditEvidence(prompt)) return;

  deny(
    CONFIG_KEY,
    'Blocked: this delegation prompt asks to create a new script/checker/gate/hook/linter/' +
      'tool, and nothing in the prompt shows a prior audit. No filesystem exploration is ' +
      `needed to fix this — add ONE phrase to the prompt such as "${AUDIT_EXAMPLE_PHRASE}" ` +
      `(any phrase matching /${AUDIT_DONE_PATTERN.source}/iu works). Then relaunch the same delegation.`,
  );
}

function stripTrailingSlash(folder) {
  let name = String(folder);
  while (name.endsWith('/') || name.endsWith('\\')) name = name.slice(0, -1);
  return name;
}

function isForeignPath(filePath) {
  return filePath
    .split('/')
    .some((segment) => FOREIGN_SEGMENTS.has(segment.toLowerCase()));
}

function checkWrite(toolInput, parameters, root) {
  const rawPath = writtenPathOf(toolInput);
  const filePath = rawPath.replace(/\\/g, '/');
  if (!filePath || isForeignPath(filePath)) return;
  const isTool = isToolPath(filePath, {
    folders: parameters.toolFolders.map(stripTrailingSlash),
    extensions: parameters.executableExtensions,
    namePatterns: [],
  });
  if (!isTool) return;
  if (existsSync(isAbsolute(rawPath) ? rawPath : join(root, rawPath))) return;
  if (hasAuditEvidence(writtenContentOf(toolInput))) return;

  deny(
    CONFIG_KEY,
    `Blocked: '${filePath}' is a new executable tool with no audit statement in its ` +
      'content. No filesystem exploration is needed to fix this — add ONE comment line ' +
      `such as "// justification: ${AUDIT_EXAMPLE_PHRASE}" (any phrase matching ` +
      `/${AUDIT_DONE_PATTERN.source}/iu works). Then retry the exact same write.`,
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      executableExtensions: DEFAULT_EXECUTABLE_EXTENSIONS,
      toolFolders: DEFAULT_TOOL_FOLDERS,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (toolInGroups(toolName, ['delegation'])) {
      checkDelegation(toolInput);
      return;
    }
    if (!toolInGroups(toolName, ['write'])) return;
    checkWrite(toolInput, parameters, projectRootOf(cwd) ?? cwd);
  },
);
