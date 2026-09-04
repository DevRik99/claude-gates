// force-parallel — denies delegations that keep arriving one turn at a time instead of as a
// batch. Deterministic: when the sequential count hits the threshold, the delegation is
// blocked outright — the agent must collect independent delegations and send them together.
//
// Decisions: delegations landing within BATCH_GAP_MS of each other are ONE batch (a parallel
// launch in a single message) and do not raise the sequential count; only a gap between the
// batch threshold and `sequentialWindowMs` counts as sequential, and a longer gap resets.
// State lives in the shared session store (sanitized session segment, project-keyed bucket
// when the payload has no session id, atomic writes, TTL pruning).

import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import {
  readSessionState,
  writeSessionState,
} from '../../lib/session-state.mjs';

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

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      sequentialThreshold: DEFAULT_SEQUENTIAL_THRESHOLD,
      sequentialWindowMs: DEFAULT_SEQUENTIAL_WINDOW_MS,
      sequentialJustifiedMarker: DEFAULT_JUSTIFIED_MARKER,
    },
  },
  ({ toolName, toolInput, sessionId, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const marker = String(parameters.sequentialJustifiedMarker ?? '');
    const prompt = delegationPromptOf(toolInput);
    if (marker && prompt.includes(marker)) return;

    const stateOptions = { cwd };
    const stored = readSessionState(GATE_ID, sessionId, {}, stateOptions);
    const previous = {
      count: Number(stored.count) || 0,
      lastAt: Number(stored.lastAt) || 0,
    };
    const now = Date.now();
    const count = nextCount(previous, now, parameters.sequentialWindowMs);
    writeSessionState(GATE_ID, sessionId, { count, lastAt: now }, stateOptions);

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
  },
);
