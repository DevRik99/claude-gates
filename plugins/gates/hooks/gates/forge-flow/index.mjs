// forge-flow — the enforcer forge cannot be. A forge MCP directs a pipeline but cannot
// intercept Edit/Write/Bash, so nothing makes you actually use it. This gate closes that
// hole: in a project that ADOPTED forge, a code-mutating action is denied unless there is
// an active forge run for this project — so every change goes through the pipeline and you
// always know which phase you are in.
//
// justification: no existing tool covers this. A forge MCP audit (see memory
// forge-mcp-auditoria-flujo) confirmed the structural hole: an MCP cannot gate other tools;
// only a Claude Code PreToolUse hook can. This is that hook.
//
// ── When it acts (never surprises you) ──────────────────────────────────────────────
// Only when the project adopted forge — a marker on disk (.ai/forge.json, or `forge: true`
// in .ai/config.json). In any other project it stays silent. Off by default in the
// registry, so it never fires unless a project turns it on.
//
// ── How it checks (deterministic, no judgment) ──────────────────────────────────────
// forge persists its runs in a SQLite DB (global by default). This gate reads that DB with
// node:sqlite (a Node built-in — no npm, contract intact) and looks for an active run whose
// cwd matches this project. Absent → deny with an actionable message. The DB unreadable or
// node:sqlite unavailable → allow (fail open: a broken lookup must not block all work).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'forge-flow';
const CONFIG_KEY = 'requireForgeRunToEdit';

const ACTING_TOOLS = new Set([...TOOL_GROUPS.write, ...TOOL_GROUPS.shell]);
const PROJECT_ROOT_MARKERS = ['.git', '.ai'];
const DEFAULT_FORGE_DB = join('.forge', 'forge-mcp.db');
const FORGE_MARKER_FILE = join('.ai', 'forge.json');
const PROJECT_CONFIG_FILE = join('.ai', 'config.json');

function projectRootOf(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (
      PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** True when this project opted into forge: a marker file, or forge:true in .ai/config.json. */
function projectAdoptedForge(root) {
  if (existsSync(join(root, FORGE_MARKER_FILE))) return true;
  const config = readJson(join(root, PROJECT_CONFIG_FILE));
  return config?.forge === true;
}

/**
 * True when forge has an active run whose cwd is this project. Reads forge's SQLite DB with
 * node:sqlite (imported dynamically so an older Node without it degrades instead of
 * throwing). Any failure — module missing, DB absent, locked, unreadable, schema drift —
 * returns true: the gate must fail OPEN, since a broken lookup must never block every edit.
 */
async function hasActiveForgeRun(root, forgeDatabasePath) {
  if (!existsSync(forgeDatabasePath)) return false; // no DB yet → no runs at all → deny
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(forgeDatabasePath, { readOnly: true });
    const rows = database
      .prepare("SELECT cwd FROM runs WHERE status = 'active'")
      .all();
    database.close();
    return rows.some((row) => String(row.cwd) === root);
  } catch {
    return true; // node:sqlite missing, or DB locked/unreadable → fail open
  }
}

const DENY_MESSAGE =
  'This project uses forge, but there is no active forge run for it. Every change should ' +
  'go through the pipeline so the next step is always clear. Start or resume a run ' +
  '(forge_start / forge_next) before editing — that is how forge tells you which phase ' +
  'you are in. To work outside the pipeline, turn this gate off in .ai/config.json.';

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: { forgeDatabasePath: join(homedir(), DEFAULT_FORGE_DB) },
  },
  async ({ toolName, parameters }) => {
    if (!ACTING_TOOLS.has(toolName)) return;

    const root = projectRootOf(process.cwd());
    if (!root) return; // no project
    if (!projectAdoptedForge(root)) return; // project did not opt into forge

    const forgeDatabasePath =
      parameters.forgeDatabasePath ?? join(homedir(), DEFAULT_FORGE_DB);
    if (await hasActiveForgeRun(root, forgeDatabasePath)) return;

    deny(GATE_ID, DENY_MESSAGE);
  },
);
