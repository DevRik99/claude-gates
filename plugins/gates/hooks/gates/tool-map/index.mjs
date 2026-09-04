// tool-map — the write half of the discovery pair (reuse-before-build reads). When a tool
// is created WITH its audit declared, the tool and that audit line are recorded in the
// project's tool map so the discovery is never repeated. Never denies; warns once when it
// cannot record. What counts as a tool and as an audit line is the same lib definition
// reuse-before-build uses, so the map records exactly what the read half accepts.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import {
  runGate,
  warn,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';
import {
  DEFAULT_TOOL_EXTENSIONS,
  DEFAULT_TOOL_FOLDERS,
  DEFAULT_TOOL_NAME_PATTERNS,
  hasAuditEvidence,
  isToolPath,
} from '../../lib/tools.mjs';

const GATE_ID = 'tool-map';
const CONFIG_KEY = 'maintainToolMap';

const DEFAULT_TOOL_MAP_FILE = join('.ai', 'tool-map.json');
const JSON_INDENT = 2;
const MAX_AUDIT_LENGTH = 300;

// Same rule as reuse-before-build: a map path outside the project root is ignored.
function toolMapPathFor(root, toolMapFile) {
  const resolved = resolve(root, String(toolMapFile || DEFAULT_TOOL_MAP_FILE));
  const relativePath = relative(root, resolved);
  const inside =
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath);
  return inside ? resolved : join(root, DEFAULT_TOOL_MAP_FILE);
}

function auditLineOf(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => hasAuditEvidence(line));
}

function normalizePath(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function rootRelativePath(root, rawPath) {
  const absolute = isAbsolute(rawPath) ? rawPath : join(root, rawPath);
  const relativePath = normalizePath(relative(root, absolute));
  return relativePath.startsWith('..') ? normalizePath(rawPath) : relativePath;
}

function readMap(path) {
  const parsed = readJsonOrNull(path);
  return Array.isArray(parsed?.tools) ? parsed : { tools: [] };
}

// The file being recorded does not exist yet at PreToolUse time, so it is exempt from
// the prune; every other entry must still point at a real file.
function recordTool(root, mapPath, toolPath, auditLine) {
  const map = readMap(mapPath);
  const kept = map.tools.filter((tool) => {
    const recorded = normalizePath(tool?.path);
    return recorded !== toolPath && existsSync(join(root, recorded));
  });
  const unchanged =
    kept.length === map.tools.length &&
    map.tools.some((tool) => normalizePath(tool?.path) === toolPath);
  if (unchanged) return;

  const tools = [
    ...kept,
    {
      path: toolPath,
      audit: auditLine.slice(0, MAX_AUDIT_LENGTH),
      recordedAt: new Date().toISOString(),
    },
  ];
  try {
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(
      mapPath,
      `${JSON.stringify({ ...map, tools }, null, JSON_INDENT)}\n`,
      'utf8',
    );
  } catch (error) {
    warn(
      CONFIG_KEY,
      `Could not record this tool in ${mapPath}: ${error?.message ?? error}. ` +
        'The build proceeds, but the discovery was not remembered.',
    );
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      toolMapFile: DEFAULT_TOOL_MAP_FILE,
      toolFolders: DEFAULT_TOOL_FOLDERS,
      toolExtensions: DEFAULT_TOOL_EXTENSIONS,
      toolNamePatterns: DEFAULT_TOOL_NAME_PATTERNS,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['write'])) return;

    const rawPath = writtenPathOf(toolInput);
    const isTool = isToolPath(rawPath, {
      folders: parameters.toolFolders,
      extensions: parameters.toolExtensions,
      namePatterns: parameters.toolNamePatterns,
    });
    if (!isTool) return;

    const auditLine = auditLineOf(writtenContentOf(toolInput));
    if (!auditLine) return;

    const root = projectRootOf(cwd) ?? cwd;
    recordTool(
      root,
      toolMapPathFor(root, parameters.toolMapFile),
      rootRelativePath(root, rawPath),
      auditLine,
    );
  },
);
