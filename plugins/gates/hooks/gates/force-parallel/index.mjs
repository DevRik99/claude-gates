// force-parallel — nudges toward parallelizing independent delegations. WARN-only: it
// never denies, because a PreToolUse hook sees one tool call at a time and has no way to
// know whether the delegations it observed COULD have been sent together — only that they
// arrived one after another.
//
// justification: no existing tool covers this. brief-before-delegate/intent-flow/risk-level
// gate the CONTENT of a single delegation prompt; none of them look across delegations in
// the same session to notice a sequential pattern.
//
// ── Honest limitation (read before trusting this gate) ──────────────────────────────
// A PreToolUse hook fires once per tool call, synchronously, with no visibility into what
// the model is "thinking" or whether independent work existed to batch. This gate can only
// count consecutive delegation calls that land close together in wall-clock time and warn
// after a threshold — it cannot prove they were independent, and it cannot force the model
// to have sent them in one message (Claude Code's own turn structure decides that, not a
// hook). Treat the warning as a nudge for the NEXT delegation, never as proof of a missed
// opportunity on the ones already sent.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   sequentialThreshold      consecutive delegations (within the window) before warning.
//   sequentialWindowMs       how close in time two delegations must land to count as the
//                            same sequential run; a gap resets the count.
//   sequentialJustifiedMarker  a marker token in the delegation prompt that escapes the
//                            warning — a declared reason not to parallelize is a decision.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.
//
// ── State ─────────────────────────────────────────────────────────────────────────────
// Per-session count + last-delegation timestamp, persisted at
// os.tmpdir()/claude-gates/force-parallel/<sessionId>/state.json — process-local state
// would not survive across the separate process each hook invocation spawns.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGate,
  warn,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'force-parallel';
const CONFIG_KEY = 'warnSequentialDelegations';

const DELEGATION_GROUPS = ['delegation'];
const DEFAULT_SEQUENTIAL_THRESHOLD = 3;
const DEFAULT_SEQUENTIAL_WINDOW_MS = 120000;
const DEFAULT_JUSTIFIED_MARKER = 'SEQUENTIAL-JUSTIFIED';
const MS_PER_SECOND = 1000;

const STATE_ROOT = join(tmpdir(), 'claude-gates', 'force-parallel');
const STATE_FILE = 'state.json';
const UNKNOWN_SESSION = 'unknown-session';

function statePathFor(sessionId) {
  const safeSessionId = String(sessionId || UNKNOWN_SESSION).replace(
    /[^\w-]/g,
    '_',
  );
  return join(STATE_ROOT, safeSessionId, STATE_FILE);
}

function readState(path) {
  if (!existsSync(path)) return { count: 0, lastAt: 0 };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      count: Number(parsed.count) || 0,
      lastAt: Number(parsed.lastAt) || 0,
    };
  } catch {
    return { count: 0, lastAt: 0 };
  }
}

function writeState(path, state) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(state), 'utf8');
}

const WARN_MESSAGE =
  'This is the {count}th delegation sent one-by-one within {windowSeconds}s. If the ' +
  'remaining work is independent, launch the next batch together in a single message ' +
  '(multiple tool calls) instead of one delegation per turn. If this delegation ' +
  'genuinely depends on a prior result, ignore this and mark the prompt with ' +
  '"{marker}" to skip the warning next time.';

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      sequentialThreshold: DEFAULT_SEQUENTIAL_THRESHOLD,
      sequentialWindowMs: DEFAULT_SEQUENTIAL_WINDOW_MS,
      sequentialJustifiedMarker: DEFAULT_JUSTIFIED_MARKER,
    },
  },
  ({ toolName, toolInput, sessionId, parameters }) => {
    if (!toolInGroups(toolName, DELEGATION_GROUPS)) return;

    const marker =
      parameters.sequentialJustifiedMarker ?? DEFAULT_JUSTIFIED_MARKER;
    const prompt = delegationPromptOf(toolInput);
    if (prompt.includes(marker)) return; // declared reason not to parallelize: no warning

    const threshold =
      parameters.sequentialThreshold ?? DEFAULT_SEQUENTIAL_THRESHOLD;
    const windowMs =
      parameters.sequentialWindowMs ?? DEFAULT_SEQUENTIAL_WINDOW_MS;

    const statePath = statePathFor(sessionId);
    const state = readState(statePath);
    const now = Date.now();

    const withinWindow = now - state.lastAt <= windowMs;
    const nextCount = withinWindow ? state.count + 1 : 1;

    writeState(statePath, { count: nextCount, lastAt: now });

    if (nextCount < threshold) return;

    warn(
      CONFIG_KEY,
      WARN_MESSAGE.replace('{count}', String(nextCount))
        .replace(
          '{windowSeconds}',
          String(Math.round(windowMs / MS_PER_SECOND)),
        )
        .replace('{marker}', marker),
    );
  },
);
