// root-whitelist — denies creating a new file or folder at the project's ROOT unless it
// is on the declared whitelist. Migrated from ~/.claude/hooks/guard-root-whitelist.mjs.
// A root grows orphaned files silently: nothing else stops a stray file from landing next
// to package.json. Only the top level of the project is governed — anything nested is
// this gate's business only insofar as its first path segment is the new thing at the root.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   rootFilesWhitelist    root-level file names allowed to be created. Replaces the
//                         built-in list wholesale.
//   rootFoldersWhitelist  root-level folder names allowed to be created. Replaces the
//                         built-in list wholesale.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces. A dotfile/dotfolder (.gitignore, .claude) is always allowed —
// dotfiles are a different, well-known convention this gate does not police.

import { basename, isAbsolute, resolve, sep } from 'node:path';
import {
  runGate,
  deny,
  toolInGroups,
  writtenPathOf,
  shellWrittenPaths,
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

const DEFAULT_ROOT_FOLDERS_WHITELIST = [
  'src',
  'tests',
  'docs',
  'scripts',
  'plugins',
];

// The whitelist verdict for one target path. Returns a deny reason string when the path is a
// non-whitelisted new thing at the project root, or null when it is allowed (outside the root,
// a dotfile, or whitelisted). Shared by the write-tool path and every shell-created path, so a
// `printf x > basura.txt` is judged by the same rule as a Write to basura.txt.
function rootWhitelistViolation(target, filesWhitelist, foldersWhitelist) {
  if (!target) return null;

  // Some tools send a path relative to cwd rather than absolute. resolve() leaves an
  // already-absolute path merely normalized ('..' collapsed, separators fixed), and resolves
  // a relative one against process.cwd() — so either shape lands on the same absolute path.
  const normalized = isAbsolute(target)
    ? resolve(target)
    : resolve(process.cwd(), target);
  const projectRoot = process.cwd() + sep;

  // A path outside the project (scratchpad, temp, another repo) is not at its root — not this
  // rule's business. Judged AFTER resolving, so a relative path is judged by where it lands.
  if (!normalized.startsWith(projectRoot)) return null;

  const relativePath = normalized.slice(projectRoot.length);

  if (!relativePath.includes(sep)) {
    const fileName = basename(relativePath);
    if (fileName.startsWith('.') || filesWhitelist.has(fileName.toLowerCase())) return null;
    return `'${fileName}' at the project root is not on the whitelist (${[...filesWhitelist].join(', ')}).`;
  }

  const topDirectory = relativePath.split(sep)[0];
  if (topDirectory.startsWith('.') || foldersWhitelist.has(topDirectory.toLowerCase())) {
    return null;
  }
  return `Folder '${topDirectory}' at the project root is not on the whitelist (${[...foldersWhitelist].join(', ')}).`;
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
  ({ toolName, toolInput, parameters }) => {
    const isWrite = toolInGroups(toolName, ['write']);
    const isShell = toolInGroups(toolName, ['shell']);
    if (!isWrite && !isShell) return;

    // Windows filesystems are case-insensitive: 'Package.json' and 'package.json' are the same
    // file. Comparing lowercase on both sides avoids a false positive on a case difference.
    const filesWhitelist = new Set(
      (parameters.rootFilesWhitelist ?? []).map((name) => name.toLowerCase()),
    );
    const foldersWhitelist = new Set(
      (parameters.rootFoldersWhitelist ?? []).map((name) => name.toLowerCase()),
    );

    // The paths to judge: a write tool's target, OR every path a shell command creates via a
    // redirection / touch / tee / cp / mv. The latter closes the hole where `> basura.txt`
    // created a root file that a Write to the same name would have been denied. This does not
    // resolve a dynamically built path (`> "$f"`) — that honest limitation is the boundary of
    // a regex, and is why the write-tool path (which carries a concrete file_path) stays the
    // primary, most reliable surface.
    const targets = isShell
      ? shellWrittenPaths(String(toolInput?.command ?? toolInput?.CommandLine ?? ''))
      : [writtenPathOf(toolInput)];

    for (const target of targets) {
      const reason = rootWhitelistViolation(target, filesWhitelist, foldersWhitelist);
      if (reason) deny(GATE_ID, reason);
    }
  },
);
