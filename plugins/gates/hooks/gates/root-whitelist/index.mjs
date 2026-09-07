// root-whitelist — denies CREATING a file or folder at the project's root unless its name is
// whitelisted. Only the top level is governed, and only new entries: an edit to a file that
// already exists (registry.json, CHANGELOG.md) is not this gate's business, nor is a path
// outside the project (a scratchpad, /tmp). Dotfiles and dotfolders are always allowed — a
// different, well-known convention. The root is the nearest .git/.ai ancestor of the cwd, so a
// tool call from a subfolder is judged against the same root. A path built from a variable is
// not resolved.

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  deny,
  runGate,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
  writtenPathOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'root-whitelist';
const CONFIG_KEY = 'blockPathsOutsideRootWhitelist';

const DEFAULT_ROOT_FILES_WHITELIST = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'eslint.config.mjs',
  'eslint.config.js',
  'eslint.config.cjs',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierignore',
  '.eslintignore',
  'cspell.json',
  '.cspell.json',
  '.gitignore',
  '.env',
  '.env.example',
];

// Broad on purpose: a root folder is a deliberate structural choice every framework makes
// differently; the value of this gate is the stray FILE next to package.json.
const DEFAULT_ROOT_FOLDERS_WHITELIST = [
  'src',
  'app',
  'lib',
  'pkg',
  'packages',
  'apps',
  'libs',
  'components',
  'pages',
  'api',
  'routes',
  'server',
  'client',
  'shared',
  'core',
  'modules',
  'features',
  'public',
  'static',
  'assets',
  'styles',
  'templates',
  'views',
  'layouts',
  'middleware',
  'plugins',
  'store',
  'stores',
  'hooks',
  'composables',
  'utils',
  'helpers',
  'services',
  'config',
  'configs',
  'i18n',
  'locales',
  'tests',
  'test',
  '__tests__',
  'e2e',
  'cypress',
  'docs',
  'doc',
  'examples',
  'example',
  'scripts',
  'tools',
  'bin',
  'dist',
  'build',
  'out',
  'coverage',
  'node_modules',
  'vendor',
  'target',
  'migrations',
  'prisma',
  'db',
  'database',
  'docker',
  '.github',
];

const IS_WINDOWS = process.platform === 'win32';
const GIT_BASH_DRIVE_PATTERN = /^\/([a-z])(?=\/|$)/i;

// Git Bash spells C:\Users as /c/Users; on Windows that form is otherwise resolved to C:\c\.
function toNativePath(path) {
  if (!IS_WINDOWS) return path;
  return path.replace(
    GIT_BASH_DRIVE_PATTERN,
    (_, drive) => `${drive.toUpperCase()}:`,
  );
}

function comparable(path) {
  return IS_WINDOWS ? path.toLowerCase() : path;
}

// The first path segment under the root, or null when the path is outside the project.
function rootEntryOf(target, cwd, root) {
  const absolute = resolve(cwd, toNativePath(target));
  const relativePath = relative(comparable(root), comparable(absolute));
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  )
    return null;
  const [name] = relativePath.split(sep);
  return {
    name,
    isNested: relativePath.includes(sep),
    path: resolve(root, name),
  };
}

function whitelistViolation({ target, isFolder }, context) {
  const entry = rootEntryOf(target, context.cwd, context.root);
  if (!entry || entry.name.startsWith('.') || existsSync(entry.path))
    return null;
  const judgedAsFolder = isFolder || entry.isNested;
  const whitelist = judgedAsFolder
    ? context.foldersWhitelist
    : context.filesWhitelist;
  if (whitelist.has(entry.name.toLowerCase())) return null;
  const kind = judgedAsFolder ? 'Folder' : 'File';
  const parameter = judgedAsFolder
    ? 'rootFoldersWhitelist'
    : 'rootFilesWhitelist';
  return (
    `${kind} '${entry.name}' would be created at the project root and is not on the ` +
    `whitelist (${[...whitelist].join(', ')}). Put it inside an existing folder, or add ` +
    `it to ${parameter} under ${CONFIG_KEY} in .ai/config.json.`
  );
}

// ── Shell targets ───────────────────────────────────────────────────────────────────
const SEGMENT_SEPARATOR = /;|&&|\|\||\||\n/;
const ARGUMENT_PATTERN = /"([^"]*)"|'([^']*)'|(\S+)/g;
const MKDIR_PREFIX = /^mkdir(?=\s)/i;
const GIT_CLONE_PREFIX = /^git\s+clone(?=\s)/i;
const NEW_ITEM_PREFIX = /^New-Item(?=\s)/i;
const DIRECTORY_ITEM_TYPE = /-ItemType\s+Directory\b/i;
const NAMED_PATH_PARAMETER =
  /-(?:Path|Name|LiteralPath)\s+("[^"]*"|'[^']*'|\S+)/i;

function nonFlagArguments(text) {
  const found = [];
  for (const match of text.matchAll(ARGUMENT_PATTERN)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (!token.startsWith('-')) found.push(token);
  }
  return found;
}

function argumentsAfter(prefix, segment) {
  const match = prefix.exec(segment);
  return match ? segment.slice(match[0].length) : null;
}

function newDirectoryItemTarget(segment) {
  if (!NEW_ITEM_PREFIX.test(segment) || !DIRECTORY_ITEM_TYPE.test(segment))
    return null;
  const remainder = segment.replace(DIRECTORY_ITEM_TYPE, '');
  const named = NAMED_PATH_PARAMETER.exec(remainder);
  if (named) return named[1].replace(/^["']|["']$/g, '');
  return (
    nonFlagArguments(argumentsAfter(NEW_ITEM_PREFIX, remainder))[0] ?? null
  );
}

function cloneDestination(argumentText) {
  const [url, destination] = nonFlagArguments(argumentText);
  if (destination) return destination;
  const base = String(url ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
  return base ? base.replace(/\.git$/i, '') : null;
}

function folderTargetsOf(command) {
  const folders = new Set();
  for (const rawSegment of String(command).split(SEGMENT_SEPARATOR)) {
    const segment = rawSegment.trim();
    const mkdirArguments = argumentsAfter(MKDIR_PREFIX, segment);
    if (mkdirArguments !== null)
      nonFlagArguments(mkdirArguments).forEach((path) => folders.add(path));
    const directoryItem = newDirectoryItemTarget(segment);
    if (directoryItem) folders.add(directoryItem);
    const cloneArguments = argumentsAfter(GIT_CLONE_PREFIX, segment);
    const destination =
      cloneArguments === null ? null : cloneDestination(cloneArguments);
    if (destination) folders.add(destination);
  }
  return folders;
}

const CD_PREFIX = /^cd(?=\s|$)/i;
const UNRESOLVED_PATH = /[$`%]/;

/**
 * Where a `cd` leaves the shell, or `null` when that cannot be known (a variable, `cd -`,
 * or bare `cd` to the home directory). `undefined` means the segment was not a `cd` at all,
 * which is why this never collapses the two into one falsy answer.
 */
function cdDestinationOf(segment, base) {
  const argumentText = argumentsAfter(CD_PREFIX, segment);
  if (argumentText === null) return undefined;
  const [destination] = nonFlagArguments(argumentText);
  if (!destination || destination === '-' || UNRESOLVED_PATH.test(destination))
    return null;
  return base === null ? null : resolve(base, toNativePath(destination));
}

function segmentTargets(segment, base) {
  const folders = folderTargetsOf(segment);
  const targets = shellWrittenPaths(segment).map((path) => ({
    target: path,
    isFolder: folders.has(path) || /[\\/]$/.test(path),
    base,
  }));
  for (const folder of folders) {
    if (!targets.some((entry) => entry.target === folder))
      targets.push({ target: folder, isFolder: true, base });
  }
  return targets;
}

/**
 * `cd scratchpad && mkdir report` creates nothing at the project root, but resolving every
 * target against the hook's cwd said it did — the gate denied work happening in a temp
 * directory. Targets are resolved against where the command has walked to by that point, and
 * once a `cd` lands somewhere unknowable the rest is left alone: an unknown base cannot
 * honestly be called the root, and this gate already refuses to resolve variables.
 */
function shellTargetsOf(command, cwd) {
  const targets = [];
  let base = cwd;
  for (const rawSegment of String(command).split(SEGMENT_SEPARATOR)) {
    const segment = rawSegment.trim();
    const destination = cdDestinationOf(segment, base);
    if (destination !== undefined) {
      base = destination;
      continue;
    }
    if (base !== null) targets.push(...segmentTargets(segment, base));
  }
  return targets.filter((entry) => !UNRESOLVED_PATH.test(entry.target));
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      rootFilesWhitelist: DEFAULT_ROOT_FILES_WHITELIST,
      rootFoldersWhitelist: DEFAULT_ROOT_FOLDERS_WHITELIST,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    let targets;
    if (toolInGroups(toolName, ['write'])) {
      const path = writtenPathOf(toolInput);
      targets = path ? [{ target: path, isFolder: false }] : [];
    } else if (toolInGroups(toolName, ['shell'])) {
      targets = shellTargetsOf(shellCommandOf(toolInput));
    } else {
      return;
    }
    if (targets.length === 0) return;

    const lowered = (names) => new Set(names.map((name) => name.toLowerCase()));
    const context = {
      cwd,
      root: projectRootOf(cwd) ?? cwd,
      filesWhitelist: lowered(parameters.rootFilesWhitelist),
      foldersWhitelist: lowered(parameters.rootFoldersWhitelist),
    };
    for (const entry of targets) {
      const reason = whitelistViolation(entry, context);
      if (reason) deny(CONFIG_KEY, reason);
    }
  },
);
