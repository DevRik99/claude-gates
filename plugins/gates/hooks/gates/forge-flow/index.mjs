// forge-flow — in a project that ADOPTED forge (.ai/forge.json, or `forge: true` in
// .ai/config.json), a code-mutating action is denied unless forge has an active run for
// this project. A forge MCP cannot intercept Edit/Write/Bash; only this hook can.
// The run's cwd may be the project root or any ANCESTOR of it (a monorepo run covers its
// packages); paths are compared normalized, case-insensitively on Windows.
// The DB is read with node:sqlite (a built-in, so the plugin stays npm-free). A DB that is
// absent means no runs → deny; a DB that cannot be read means "unknown" → warn and allow,
// so a broken lookup never freezes work and never disables the enforcer silently.
//
// It also enforces WHO acts (`subagentOnly`, on by default). forge's model is that every
// phase is run by a dedicated subagent while the main agent directs, and forge itself cannot
// enforce that — an MCP sees only its own tools. This hook can, because Claude Code writes a
// subagent's turns to a separate transcript and the payload carries its path (see
// lib/agent-context.mjs). Two consequences shape the rules below:
//
//   - The main agent is denied EXECUTION, never reading, and the denial names the exact
//     forge tools to call next. A gate that only says "no" leaves the model guessing.
//   - A DELEGATION is inspected, not blocked. If its prompt carries a [forge:runId:phase]
//     marker it must match the run's real current phase — that is what stops a replayed or
//     invented brief. A delegation with no marker passes: not every subagent launched during
//     a run claims to be a phase, and denying those would make the gate a cage.
//
// The enforcement is only as strong as its weakest half: this hook proves a subagent acted,
// forge proves the evidence satisfies the phase contract, and neither proves the reported
// exit codes were ever really produced. See forge-mcp's PROTOCOL.md for that open hole.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_CONTEXT, agentContextOf } from '../../lib/agent-context.mjs';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import {
  runGate,
  deny,
  warn,
  delegationPromptOf,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
} from '../../lib/hook-io.mjs';
import {
  isReadOnlyCommand,
  isSelfRemedyCommand,
} from '../../lib/shell-safety.mjs';

const GATE_ID = 'forge-flow';
const CONFIG_KEY = 'requireForgeRunToEdit';

const ACTING_GROUPS = ['execution'];
const DELEGATION_GROUPS = ['delegation'];
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

// El run activo se devuelve entero (id + fase) y no solo un booleano, porque el token de
// delegación se valida contra la fase REAL: sin la fase, el brief de una fase ya cerrada
// pasaría igual.
async function forgeRunState(root, databasePath) {
  if (!existsSync(databasePath)) return { state: 'none' };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT id, cwd, current_phase FROM runs WHERE status = 'active'",
      )
      .all();
    database.close();
    const covering = rows.find((row) => runCovers(row.cwd, root));
    return covering
      ? {
          state: 'active',
          runId: String(covering.id),
          phase: String(covering.current_phase ?? ''),
        }
      : { state: 'none' };
  } catch (error) {
    return { state: 'unknown', reason: error?.message ?? String(error) };
  }
}

const PHASE_TOKEN_PATTERN = /\[forge:([^\]:]+):([^\]:]+)\]/;

function phaseTokenOf(prompt) {
  const match = PHASE_TOKEN_PATTERN.exec(String(prompt ?? ''));
  return match ? { runId: match[1], phase: match[2] } : null;
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

// Encamina en vez de solo negar: dice la secuencia exacta de tools, porque un "no" seco deja
// al modelo adivinando cuál de los 50 gates quiere qué.
function mainAgentDenyMessage(phase, runId) {
  return (
    `forge run ${runId} is at phase "${phase}", and that phase is executed by a DEDICATED ` +
    'SUBAGENT, not by you. You direct; the subagent builds. Do this instead:\n' +
    `  1. forge_next — returns the phase brief and its [forge:${runId}:${phase}] marker.\n` +
    `  2. forge_start_phase(agentId="<the subagent you launch>") — starts the phase clock.\n` +
    '  3. Launch an Agent with that prompt verbatim, marker included. It may edit and run ' +
    'commands; you may not.\n' +
    '  4. forge_complete_phase with its summary, evidence and the same agentId.\n' +
    'Reading is still yours: Read/Grep/Glob and read-only commands are never blocked. To ' +
    `let the main agent build directly, set subagentOnly to false under ${CONFIG_KEY}.`
  );
}

function staleTokenDenyMessage(claimed, phase, runId) {
  return (
    `This delegation carries the forge marker [forge:${claimed.runId}:${claimed.phase}], but ` +
    `run ${runId} is at phase "${phase}". A brief from another phase (or another run) is not ` +
    'the criterion for the phase you are actually in. Call forge_next to get the current ' +
    'brief and launch the subagent with that one.'
  );
}

function isDiagnosticOrRemedy(toolName, toolInput) {
  if (!toolInGroups(toolName, ['shell'])) return false;
  const command = shellCommandOf(toolInput);
  if (isSelfRemedyCommand(command)) return true;
  return isReadOnlyCommand(command, {
    writesPaths: shellWrittenPaths(command).length > 0,
  });
}

// Porque una delegación lanzada durante un run no siempre dice ser la ejecución de una fase,
// la que no lleva token pasa; se deniega solo la que reclama una fase que no toca.
function denyStaleDelegation(toolInput, run) {
  const claimed = phaseTokenOf(delegationPromptOf(toolInput));
  if (!claimed) return;
  if (claimed.runId === run.runId && claimed.phase === run.phase) return;
  deny(CONFIG_KEY, staleTokenDenyMessage(claimed, run.phase, run.runId));
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      forgeDbPath: DEFAULT_FORGE_DB_PATH,
      forgeDatabasePath: DEFAULT_FORGE_DB_PATH,
      subagentOnly: true,
    },
  },
  async ({ rawPayload, toolName, toolInput, parameters, cwd }) => {
    const isActing = toolInGroups(toolName, ACTING_GROUPS);
    const isDelegating = toolInGroups(toolName, DELEGATION_GROUPS);
    if (!isActing && !isDelegating) return;

    const root = projectRootOf(cwd);
    if (!root || !projectAdoptedForge(root)) return;

    // Invariante que cumple cada gate: mirar por qué estás bloqueado, y el remedio del
    // propio toolkit, nunca se deniegan (ver cli/__tests__/gate-invariants.test.mjs).
    if (isDiagnosticOrRemedy(toolName, toolInput)) return;

    const databasePath = configuredDatabasePath(parameters);
    const result = await forgeRunState(root, databasePath);

    if (result.state === 'unknown') {
      warn(
        CONFIG_KEY,
        `forge enforcement is degraded: the forge DB could not be read (${result.reason}). ` +
          'Allowing this action, but the pipeline is NOT being enforced. Check that forge is ' +
          `installed and ${databasePath} is readable, or turn this gate off if intended.`,
      );
    }
    if (result.state === 'none') {
      if (isDelegating) return;
      deny(CONFIG_KEY, DENY_MESSAGE);
    }

    if (isDelegating) {
      denyStaleDelegation(toolInput, result);
      return;
    }

    if (parameters.subagentOnly === false) return;

    // Porque negar sin poder identificar al llamante congelaría cualquier superficie que no
    // mande transcript_path, 'unknown' no cuenta como principal: solo se deniega MAIN.
    if (agentContextOf(rawPayload) === AGENT_CONTEXT.MAIN) {
      deny(CONFIG_KEY, mainAgentDenyMessage(result.phase, result.runId));
    }
  },
);
