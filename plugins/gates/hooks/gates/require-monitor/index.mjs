// require-monitor — enforces that every background command has an associated Monitor.
// Two-phase enforcement:
//   1. PreToolUse on shell: a command with run_in_background: true MUST carry the marker
//      MONITOR-PLANNED: <reason>. Without it, the background is denied.
//   2. PreToolUse on execution+monitor: if the session has pending unmonitored backgrounds
//      and the current tool is NOT Monitor, deny — forcing the agent to create a Monitor
//      before doing anything else. When the current tool IS Monitor, the pending background
//      is cleared.
//
// The marker is deterministic: no model judgment required. The pending-check is deterministic
// too: state is on disk, the check is a read + compare, and the deny is unconditional.

import {
  deny,
  runGate,
  shellCommandOf,
  toolInGroups,
} from '../../lib/hook-io.mjs';
import {
  readSessionState,
  writeSessionState,
} from '../../lib/session-state.mjs';

const GATE_ID = 'require-monitor';
const CONFIG_KEY = 'requireMonitorForBackground';

const DEFAULT_MARKER = 'MONITOR-PLANNED:';
const MARKER_REASON_PATTERN = /\S\s\S/;
const MAX_PENDING = 20;
const MAX_COMMAND_PREVIEW_LENGTH = 200;

function hasMarker(command, marker) {
  if (!marker) return false;
  const markerIndex = command.indexOf(marker);
  if (markerIndex === -1) return false;
  const afterMarker = command.slice(markerIndex + marker.length);
  return MARKER_REASON_PATTERN.test(afterMarker);
}

function pendingBackgrounds(state) {
  return Array.isArray(state.pending) ? state.pending : [];
}

function addPending(state, entry) {
  const pending = [...pendingBackgrounds(state), entry].slice(-MAX_PENDING);
  return { ...state, pending };
}

function clearOldestPending(state) {
  const pending = pendingBackgrounds(state);
  if (pending.length === 0) return state;
  return { ...state, pending: pending.slice(1) };
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      monitorPlannedMarker: DEFAULT_MARKER,
    },
  },
  ({ toolName, toolInput, sessionId, parameters, cwd }) => {
    const isShell = toolInGroups(toolName, ['shell']);
    const isMonitor = toolInGroups(toolName, ['monitor']);
    const isExecution = toolInGroups(toolName, ['execution']);

    if (!isShell && !isMonitor && !isExecution) return;

    const stateOptions = { cwd };
    const state = readSessionState(GATE_ID, sessionId, {}, stateOptions);
    const marker = String(parameters.monitorPlannedMarker ?? DEFAULT_MARKER);

    // Phase 2: if Monitor tool, clear oldest pending and allow.
    if (isMonitor) {
      const pending = pendingBackgrounds(state);
      if (pending.length > 0) {
        writeSessionState(
          GATE_ID,
          sessionId,
          clearOldestPending(state),
          stateOptions,
        );
      }
      return;
    }

    // Phase 1: shell with run_in_background requires the marker.
    if (isShell && toolInput.run_in_background === true) {
      const command = shellCommandOf(toolInput);
      if (!hasMarker(command, marker)) {
        deny(
          CONFIG_KEY,
          `A background command MUST declare its Monitor plan. Add "${marker} <what the ` +
            'Monitor will watch for>" to the command. Every background process needs a ' +
            'Monitor — an unmonitored background is invisible work that can hang or fail ' +
            'silently. The marker is a commitment to create a Monitor immediately after.',
        );
      }
      writeSessionState(
        GATE_ID,
        sessionId,
        addPending(state, {
          command: command.slice(0, MAX_COMMAND_PREVIEW_LENGTH),
          startedAt: Date.now(),
        }),
        stateOptions,
      );
      return;
    }

    // Phase 2: any execution/shell tool while backgrounds are unmonitored.
    const pending = pendingBackgrounds(state);
    if (pending.length > 0) {
      const oldest = pending[0];
      deny(
        CONFIG_KEY,
        `There are ${pending.length} background command(s) without a Monitor. Create a ` +
          `Monitor for the pending background before doing anything else. Oldest pending: ` +
          `"${oldest.command ?? '(unknown)'}". Use the Monitor tool to observe it, then ` +
          'proceed with your next action.',
      );
    }
  },
);
