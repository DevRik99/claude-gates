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
import { runGate, deny, toolInGroups, writtenPathOf } from '../../lib/hook-io.mjs';

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
    if (!toolInGroups(toolName, ['write'])) return;

    const target = writtenPathOf(toolInput);
    if (!target) return;

    // Some tools send a path relative to cwd rather than absolute. resolve() leaves an
    // already-absolute path merely normalized ('..' collapsed, separators fixed), and
    // resolves a relative one against process.cwd() — so either shape lands on the same
    // absolute path the root check below expects.
    const normalized = isAbsolute(target)
      ? resolve(target)
      : resolve(process.cwd(), target);
    const projectRoot = process.cwd() + sep;

    // The whitelist describes the project's ROOT. A file outside the project (session
    // scratchpad, system temp, another repo) is not at its root, and this rule does not
    // govern it: letting it through is correct, not an exception. This check runs AFTER
    // resolving relative paths, so a relative path is judged by where it actually lands.
    if (!normalized.startsWith(projectRoot)) return;

    const relativePath = normalized.slice(projectRoot.length);
    // Windows filesystems are case-insensitive: 'Package.json' and 'package.json' are the
    // same file. Comparing lowercase on both sides avoids denying a whitelisted name that
    // merely differs in case (a false positive, not a real gap).
    const filesWhitelist = new Set(
      (parameters.rootFilesWhitelist ?? []).map((name) => name.toLowerCase()),
    );
    const foldersWhitelist = new Set(
      (parameters.rootFoldersWhitelist ?? []).map((name) => name.toLowerCase()),
    );

    if (!relativePath.includes(sep)) {
      const fileName = basename(relativePath);
      if (fileName.startsWith('.') || filesWhitelist.has(fileName.toLowerCase()))
        return;
      deny(
        GATE_ID,
        `'${fileName}' at the project root is not on the whitelist (${[...filesWhitelist].join(', ')}).`,
      );
      return;
    }

    const topDirectory = relativePath.split(sep)[0];
    if (
      topDirectory.startsWith('.') ||
      foldersWhitelist.has(topDirectory.toLowerCase())
    )
      return;
    deny(
      GATE_ID,
      `Folder '${topDirectory}' at the project root is not on the whitelist (${[...foldersWhitelist].join(', ')}).`,
    );
  },
);
