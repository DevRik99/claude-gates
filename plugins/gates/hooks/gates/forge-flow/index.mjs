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
import { runGate, deny, warn, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'forge-flow';
const CONFIG_KEY = 'requireForgeRunToEdit';

// Any code-mutating surface: native write/shell AND their MCP equivalents. `execution`
// already unions write+shell+mcp__ide__executeCode, and toolInGroups adds the mcp__* signal
// match — so an MCP filesystem-write or shell-exec tool no longer slips past the enforcer.
const ACTING_GROUPS = ['execution'];
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
// Returns one of three verdicts, so a broken lookup no longer masquerades as "run present":
//   { state: 'active' }   → a run for this project exists; allow.
//   { state: 'none' }     → DB readable, no active run for this project; deny.
//   { state: 'unknown', reason } → DB absent/locked/corrupt/schema-drift, or node:sqlite
//                                   missing; we cannot tell. Warn (visible) but allow, so a
//                                   broken DB never blocks all work AND never disables the
//                                   enforcer silently — the earlier code returned true here,
//                                   which looked identical to "run present".
async function forgeRunState(root, forgeDatabasePath) {
  if (!existsSync(forgeDatabasePath)) return { state: 'none' }; // no DB yet → no runs → deny
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(forgeDatabasePath, { readOnly: true });
    const rows = database
      .prepare("SELECT cwd FROM runs WHERE status = 'active'")
      .all();
    database.close();
    return rows.some((row) => String(row.cwd) === root)
      ? { state: 'active' }
      : { state: 'none' };
  } catch (error) {
    return { state: 'unknown', reason: error?.message ?? String(error) };
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
    if (!toolInGroups(toolName, ACTING_GROUPS)) return;

    const root = projectRootOf(process.cwd());
    if (!root) return; // no project
    if (!projectAdoptedForge(root)) return; // project did not opt into forge

    const forgeDatabasePath =
      parameters.forgeDatabasePath ?? join(homedir(), DEFAULT_FORGE_DB);
    const result = await forgeRunState(root, forgeDatabasePath);

    if (result.state === 'active') return; // pipeline is running → allow
    if (result.state === 'none') deny(CONFIG_KEY, DENY_MESSAGE); // no run → block
    // state 'unknown': the DB could not be read. Allow so a broken lookup never freezes work,
    // but surface it loudly — a silent allow here would disable the enforcer without a trace.
    warn(
      CONFIG_KEY,
      `forge enforcement is degraded: the forge DB could not be read (${result.reason}). ` +
        'Allowing this action, but the pipeline is NOT being enforced. Check that forge is ' +
        `installed and ${forgeDatabasePath} is readable, or turn this gate off if intended.`,
    );
  },
);
