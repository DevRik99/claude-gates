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

import { basename, normalize, sep } from 'node:path';
import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'root-whitelist';
const CONFIG_KEY = 'blockPathsOutsideRootWhitelist';

const WRITE_TOOLS = new Set(TOOL_GROUPS.write);

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

/** The path a write tool targets, across the field names different tools use. */
function writeTargetFrom(toolInput) {
  return String(
    toolInput.TargetFile ??
      toolInput.target_file ??
      toolInput.file_path ??
      toolInput.path ??
      '',
  );
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
    if (!WRITE_TOOLS.has(toolName)) return;

    const target = writeTargetFrom(toolInput);
    if (!target) return;

    const normalized = normalize(target);
    const projectRoot = process.cwd() + sep;

    // The whitelist describes the project's ROOT. A file outside the project (session
    // scratchpad, system temp, another repo) is not at its root, and this rule does not
    // govern it: letting it through is correct, not an exception.
    if (!normalized.startsWith(projectRoot)) return;

    const relativePath = normalized.slice(projectRoot.length);
    const filesWhitelist = new Set(parameters.rootFilesWhitelist ?? []);
    const foldersWhitelist = new Set(parameters.rootFoldersWhitelist ?? []);

    if (!relativePath.includes(sep)) {
      const fileName = basename(relativePath);
      if (fileName.startsWith('.') || filesWhitelist.has(fileName)) return;
      deny(
        GATE_ID,
        `'${fileName}' at the project root is not on the whitelist (${[...filesWhitelist].join(', ')}).`,
      );
      return;
    }

    const topDirectory = relativePath.split(sep)[0];
    if (topDirectory.startsWith('.') || foldersWhitelist.has(topDirectory))
      return;
    deny(
      GATE_ID,
      `Folder '${topDirectory}' at the project root is not on the whitelist (${[...foldersWhitelist].join(', ')}).`,
    );
  },
);
