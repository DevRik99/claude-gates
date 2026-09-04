// forge-flow — in a project that ADOPTED forge (.ai/forge.json, or `forge: true` in
// .ai/config.json), a code-mutating action is denied unless forge has an active run for
// this project. A forge MCP cannot intercept Edit/Write/Bash; only this hook can.
// The run's cwd may be the project root or any ANCESTOR of it (a monorepo run covers its
// packages); paths are compared normalized, case-insensitively on Windows.
// The DB is read with node:sqlite (a built-in, so the plugin stays npm-free). A DB that is
// absent means no runs → deny; a DB that cannot be read means "unknown" → warn and allow,
// so a broken lookup never freezes work and never disables the enforcer silently.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import { runGate, deny, warn, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'forge-flow';
const CONFIG_KEY = 'requireForgeRunToEdit';

const ACTING_GROUPS = ['execution'];
const DEFAULT_FORGE_DB_PATH = join(homedir(), '.forge', 'forge-mcp.db');
const FORGE_MARKER_FILE = join('.ai', 'forge.json');
const PROJECT_CONFIG_FILE = join('.ai', 'config.json');

function projectAdoptedForge(root) {
  if (existsSync(join(root, FORGE_MARKER_FILE))) return true;
  return readJsonOrNull(join(root, PROJECT_CONFIG_FILE))?.forge === true;
}

function normalizeDirectory(path) {
  let normalized = String(path ?? '').replace(/\\/g, '/');
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function runCovers(runCwd, root) {
  const run = normalizeDirectory(runCwd);
  const project = normalizeDirectory(root);
  return run !== '' && (project === run || project.startsWith(`${run}/`));
}

async function forgeRunState(root, databasePath) {
  if (!existsSync(databasePath)) return { state: 'none' };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare("SELECT cwd FROM runs WHERE status = 'active'")
      .all();
    database.close();
    return rows.some((row) => runCovers(row.cwd, root))
      ? { state: 'active' }
      : { state: 'none' };
  } catch (error) {
    return { state: 'unknown', reason: error?.message ?? String(error) };
  }
}

// The registry documents `forgeDbPath`; `forgeDatabasePath` is the name earlier configs
// used. A declared forgeDbPath wins; otherwise whichever of the two was set applies.
function configuredDatabasePath(parameters) {
  const { forgeDbPath, forgeDatabasePath } = parameters;
  if (typeof forgeDbPath === 'string' && forgeDbPath !== DEFAULT_FORGE_DB_PATH)
    return forgeDbPath;
  return typeof forgeDatabasePath === 'string' && forgeDatabasePath
    ? forgeDatabasePath
    : DEFAULT_FORGE_DB_PATH;
}

const DENY_MESSAGE =
  'This project uses forge, but there is no active forge run for it. Every change should ' +
  'go through the pipeline so the next step is always clear. Start or resume a run ' +
  '(forge_start / forge_next) before editing — that is how forge tells you which phase ' +
  `you are in. To work outside the pipeline, set ${CONFIG_KEY} to false in .ai/config.json.`;

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      forgeDbPath: DEFAULT_FORGE_DB_PATH,
      forgeDatabasePath: DEFAULT_FORGE_DB_PATH,
    },
  },
  async ({ toolName, parameters, cwd }) => {
    if (!toolInGroups(toolName, ACTING_GROUPS)) return;

    const root = projectRootOf(cwd);
    if (!root || !projectAdoptedForge(root)) return;

    const databasePath = configuredDatabasePath(parameters);
    const result = await forgeRunState(root, databasePath);
    if (result.state === 'active') return;
    if (result.state === 'none') deny(CONFIG_KEY, DENY_MESSAGE);
    warn(
      CONFIG_KEY,
      `forge enforcement is degraded: the forge DB could not be read (${result.reason}). ` +
        'Allowing this action, but the pipeline is NOT being enforced. Check that forge is ' +
        `installed and ${databasePath} is readable, or turn this gate off if intended.`,
    );
  },
);
