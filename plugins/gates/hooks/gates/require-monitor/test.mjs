import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stateFileFor } from '../../lib/session-state.mjs';
import {
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  withSession,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const GATE_ID = 'require-monitor';

const ENABLED = { gates: { requireMonitorForBackground: true } };

function session(config = ENABLED) {
  const project = makeProject({ config });
  const sessionId = `test-${randomUUID()}`;
  return {
    sessionId,
    project,
    run: (payload) => runGateProcess(GATE, payload, { project }),
    cleanup: () => {
      try {
        rmSync(dirname(stateFileFor(GATE_ID, sessionId, { cwd: project })), {
          recursive: true,
          force: true,
        });
      } catch {
        /* state dir may not exist */
      }
    },
  };
}

function bash(command, sessionId, runInBackground = false) {
  return withSession(
    {
      tool_name: 'Bash',
      tool_input: { command, run_in_background: runInBackground },
    },
    sessionId,
  );
}

function monitor(command, sessionId) {
  return withSession(
    { tool_name: 'Monitor', tool_input: { command } },
    sessionId,
  );
}

function _agent(prompt, sessionId) {
  return withSession({ tool_name: 'Agent', tool_input: { prompt } }, sessionId);
}

// ── Phase 1: background commands require the marker ───────────────────────────
test('a background command without MONITOR-PLANNED marker is denied', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const result = run(bash('npm run build', sessionId, true));
    assert.ok(isDeny(result));
    assert.match(messageOf(result), /MONITOR-PLANNED/);
  } finally {
    cleanup();
  }
});

test('a background command with MONITOR-PLANNED marker is allowed', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const result = run(
      bash(
        'npm run build # MONITOR-PLANNED: watch for build completion',
        sessionId,
        true,
      ),
    );
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

test('MONITOR-PLANNED marker needs a reason, bare marker is not enough', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const result = run(
      bash('npm run build # MONITOR-PLANNED:', sessionId, true),
    );
    assert.ok(isDeny(result));
  } finally {
    cleanup();
  }
});

test('a non-background shell command is always allowed', () => {
  const { sessionId, run, cleanup } = session();
  try {
    assert.equal(run(bash('ls -la', sessionId, false)), null);
  } finally {
    cleanup();
  }
});

// ── Phase 2: pending backgrounds block other tools until Monitor ──────────────
test('after a marked background, any execution tool is denied until Monitor', () => {
  const { sessionId, run, cleanup } = session();
  try {
    run(
      bash(
        'npm test # MONITOR-PLANNED: watch for test results',
        sessionId,
        true,
      ),
    );
    const result = run(bash('echo hello', sessionId, false));
    assert.ok(isDeny(result));
    assert.match(messageOf(result), /Monitor/);
  } finally {
    cleanup();
  }
});

test('a Monitor tool call clears the pending background', () => {
  const { sessionId, run, cleanup } = session();
  try {
    run(
      bash(
        'npm test # MONITOR-PLANNED: watch for test output',
        sessionId,
        true,
      ),
    );
    assert.equal(run(monitor('npm test', sessionId)), null);
    assert.equal(run(bash('echo hello', sessionId, false)), null);
  } finally {
    cleanup();
  }
});

// ── Edge cases ────────────────────────────────────────────────────────────────
test('a non-shell non-monitor non-execution tool is not affected', () => {
  const { sessionId, project, run, cleanup } = session();
  try {
    const result = run(
      withSession(
        { tool_name: 'Read', tool_input: { file_path: join(project, 'x') } },
        sessionId,
      ),
    );
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

test('gate disabled: background without marker is allowed', () => {
  const { sessionId, run, cleanup } = session({
    gates: { requireMonitorForBackground: false },
  });
  try {
    assert.equal(run(bash('npm run build', sessionId, true)), null);
  } finally {
    cleanup();
  }
});

test('dump-defaults protocol: prints the descriptor', () => {
  const result = runGateProcess(GATE, '', {
    environment: { CLAUDE_GATES_DUMP_DEFAULTS: '1' },
  });
  assert.equal(result.configKey, 'requireMonitorForBackground');
  assert.equal(result.enabledByDefault, true);
  assert.ok(result.defaultParams.monitorPlannedMarker);
});
