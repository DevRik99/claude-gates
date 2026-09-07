// force-parallel — denies delegations that keep arriving one turn at a time instead of as a
// batch. Deterministic: when the sequential count hits the threshold, the delegation is
// blocked outright — the agent must collect independent delegations and send them together.
//
// Decisions: delegations landing within BATCH_GAP_MS of each other are ONE batch (a parallel
// launch in a single message) and do not raise the sequential count; only a gap between the
// batch threshold and `sequentialWindowMs` counts as sequential, and a longer gap resets.
// State lives in the shared session store (sanitized session segment, project-keyed bucket
// when the payload has no session id, atomic writes, TTL pruning).

import { AGENT_CONTEXT, agentContextOf } from '../../lib/agent-context.mjs';
import {
  runGate,
  deny,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
  delegationPromptOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';
import {
  readSessionState,
  writeSessionState,
} from '../../lib/session-state.mjs';
import {
  isReadOnlyCommand,
  isSelfRemedyCommand,
} from '../../lib/shell-safety.mjs';

const GATE_ID = 'force-parallel';
const CONFIG_KEY = 'warnSequentialDelegations';

const DEFAULT_SEQUENTIAL_THRESHOLD = 3;
const DEFAULT_SEQUENTIAL_WINDOW_MS = 120000;
const DEFAULT_JUSTIFIED_MARKER = 'SEQUENTIAL-JUSTIFIED';
const MS_PER_SECOND = 1000;
const BATCH_GAP_MS = 2000;

const ORDINAL_SUFFIXES = { 1: 'st', 2: 'nd', 3: 'rd' };
const TEENS_FROM = 11;
const TEENS_TO = 13;
const HUNDRED = 100;
const TEN = 10;

function ordinal(number) {
  const lastTwo = number % HUNDRED;
  if (lastTwo >= TEENS_FROM && lastTwo <= TEENS_TO) return `${number}th`;
  return `${number}${ORDINAL_SUFFIXES[number % TEN] ?? 'th'}`;
}

function nextCount(previous, now, windowMs) {
  const gap = now - previous.lastAt;
  if (gap > windowMs) return 1;
  if (gap < BATCH_GAP_MS) return Math.max(previous.count, 1);
  return previous.count + 1;
}

// ── Segundo disparador: el principal trabajando en serie ─────────────────────────────
// El primer disparador solo corre si YA estás delegando, así que un agente que lo hacía por
// su cuenta era invisible: medía el espaciado entre delegaciones, nunca su ausencia. Esto
// observa lo contrario — cuántos ficheros DISTINTOS toca el principal sin repartir nada.
//
// Ficheros distintos y no llamadas: editar diez veces el mismo fichero es iterar, y eso no
// se reparte. Diez ficheros distintos sí son trabajo independiente.
//
// Cualquier delegación REINICIA la cuenta, de modo que la salida del bloqueo sea exactamente
// la conducta que se pide. Y solo cuenta el PRINCIPAL: un subagente haciendo diez ediciones
// es justo lo que se quería conseguir.
const DEFAULT_MAX_SELF_EDITS = 10;

function writtenPathFor(toolName, toolInput) {
  const direct = writtenPathOf(toolInput);
  if (direct) return direct;
  if (!toolInGroups(toolName, ['shell'])) return '';
  return shellWrittenPaths(shellCommandOf(toolInput))[0] ?? '';
}

function isDiagnosticOrRemedy(toolName, toolInput) {
  if (!toolInGroups(toolName, ['shell'])) return false;
  const command = shellCommandOf(toolInput);
  if (isSelfRemedyCommand(command)) return true;
  return isReadOnlyCommand(command, {
    writesPaths: shellWrittenPaths(command).length > 0,
  });
}

function nextSelfFiles(previous, path, now, windowMs) {
  const fresh = now - Number(previous.selfLastAt ?? 0) > windowMs;
  const files = fresh ? [] : (previous.selfFiles ?? []);
  return files.includes(path) ? files : [...files, path];
}

function judgeDelegation({
  toolInput,
  sessionId,
  parameters,
  stateOptions,
  stored,
  now,
}) {
  const marker = String(parameters.sequentialJustifiedMarker ?? '');
  const prompt = delegationPromptOf(toolInput);
  if (marker && prompt.includes(marker)) return;

  const previous = {
    count: Number(stored.count) || 0,
    lastAt: Number(stored.lastAt) || 0,
  };
  const count = nextCount(previous, now, parameters.sequentialWindowMs);
  // Porque delegar es justamente la salida que pide el otro disparador, hacerlo limpia la
  // racha en serie en la misma escritura de estado.
  writeSessionState(
    GATE_ID,
    sessionId,
    { count, lastAt: now, selfFiles: [], selfLastAt: now },
    stateOptions,
  );

  if (count < parameters.sequentialThreshold) return;

  const windowSeconds = Math.round(
    parameters.sequentialWindowMs / MS_PER_SECOND,
  );
  deny(
    CONFIG_KEY,
    `This is the ${ordinal(count)} delegation sent one-by-one within ${windowSeconds}s. ` +
      'Independent delegations MUST be launched together in a single message (multiple tool ' +
      'calls in one response). Collect the remaining independent delegations and send them as ' +
      'a batch. If this delegation genuinely depends on a prior result, add ' +
      `"${marker || DEFAULT_JUSTIFIED_MARKER}" to the prompt to declare the dependency.`,
  );
}

function judgeSelfWork({
  rawPayload,
  toolName,
  toolInput,
  sessionId,
  parameters,
  stateOptions,
  stored,
  now,
}) {
  const limit = Number(parameters.maxSelfEditsBeforeDelegating) || 0;
  if (limit <= 0) return;
  if (!toolInGroups(toolName, ['execution'])) return;
  if (agentContextOf(rawPayload) !== AGENT_CONTEXT.MAIN) return;
  if (isDiagnosticOrRemedy(toolName, toolInput)) return;

  const path = writtenPathFor(toolName, toolInput);
  if (!path) return;

  const files = nextSelfFiles(stored, path, now, parameters.sequentialWindowMs);
  writeSessionState(
    GATE_ID,
    sessionId,
    { ...stored, selfFiles: files, selfLastAt: now },
    stateOptions,
  );
  if (files.length <= limit) return;

  const windowSeconds = Math.round(
    parameters.sequentialWindowMs / MS_PER_SECOND,
  );
  deny(
    CONFIG_KEY,
    `You have edited ${String(files.length)} DIFFERENT files yourself within ${windowSeconds}s ` +
      'without delegating once. Work spread over that many independent files belongs to a batch ' +
      'of subagents running in parallel, not to one agent working a queue.\n' +
      'Launch the remaining independent pieces as subagents in a SINGLE message (several ' +
      'Agent calls in one response) — any delegation clears this counter and you continue.\n' +
      'If this really is one indivisible change, raise or zero maxSelfEditsBeforeDelegating ' +
      `under ${CONFIG_KEY} in .ai/config.json.`,
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      sequentialThreshold: DEFAULT_SEQUENTIAL_THRESHOLD,
      sequentialWindowMs: DEFAULT_SEQUENTIAL_WINDOW_MS,
      sequentialJustifiedMarker: DEFAULT_JUSTIFIED_MARKER,
      maxSelfEditsBeforeDelegating: DEFAULT_MAX_SELF_EDITS,
    },
  },
  ({ rawPayload, toolName, toolInput, sessionId, parameters, cwd }) => {
    const stateOptions = { cwd };
    const stored = readSessionState(GATE_ID, sessionId, {}, stateOptions);
    const now = Date.now();

    if (toolInGroups(toolName, ['delegation'])) {
      judgeDelegation({
        toolInput,
        sessionId,
        parameters,
        stateOptions,
        stored,
        now,
      });
      return;
    }
    judgeSelfWork({
      rawPayload,
      toolName,
      toolInput,
      sessionId,
      parameters,
      stateOptions,
      stored,
      now,
    });
  },
);
