// Every fixed value the CLI relies on, in one place. Nothing else in `cli/` may
// carry a literal path segment, file name or exit code (enforced by eslint:
// no-magic-numbers + no-restricted-syntax on path-like strings).

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const REPOSITORY_ROOT = join(CLI_DIRECTORY, '..');
export const REGISTRY_FILE = 'registry.json';
export const REGISTRY_PATH = join(REPOSITORY_ROOT, REGISTRY_FILE);
export const MARKETPLACE_PATH = join(
  REPOSITORY_ROOT,
  '.claude-plugin',
  'marketplace.json',
);

/** Project-scope config lives next to the project's other `.ai/` state. */
export const PROJECT_STATE_DIRECTORY = '.ai';
export const CONFIG_FILE = 'config.json';
/** Markers that identify a project root while climbing from the cwd. */
export const PROJECT_ROOT_MARKERS = ['.git', PROJECT_STATE_DIRECTORY];

/** Global-scope config lives under Claude Code's own user directory. */
export const CLAUDE_USER_DIRECTORY = '.claude';
export const GLOBAL_STATE_DIRECTORY = 'claude-gates';

export const HOME_DIRECTORY = homedir();

export const EXIT_CODE = Object.freeze({ SUCCESS: 0, FAILURE: 1 });

export const JSON_INDENT = 2;

export const LIST_SEPARATOR = ',';
