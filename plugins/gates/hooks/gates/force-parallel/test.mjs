import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  readSessionState,
  stateFileFor,
  writeSessionState,
} from '../../lib/session-state.mjs';
import {
  isWarn,
  makeProject,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const GATE_ID = 'force-parallel';
const SEQUENTIAL_GAP_MS = 5000;

function delegationPayload(sessionId, prompt = 'do work') {
  return { tool_name: 'Task', session_id: sessionId, tool_input: { prompt } };
}

function session(config = { gates: { warnSequentialDelegations: true } }) {
  const project = makeProject({ config });
  const sessionId = `test-${randomUUID()}`;
  const options = { cwd: project };
  return {
    sessionId,
    run: (payload) => runGateProcess(GATE, payload, { project }),
    // Back-dates the last delegation so the next one reads as a new turn, not the same batch.
    age: () => {
      const state = readSessionState(GATE_ID, sessionId, {}, options);
      writeSessionState(
        GATE_ID,
        sessionId,
        { ...state, lastAt: Date.now() - SEQUENTIAL_GAP_MS },
        options,
      );
    },
    cleanup: () =>
      rmSync(dirname(stateFileFor(GATE_ID, sessionId, options)), {
        recursive: true,
        force: true,
      }),
  };
}

test('3 sequential delegations in the same session: the 3rd warns', () => {
  const { sessionId, run, age, cleanup } = session();
  try {
    const first = run(delegationPayload(sessionId));
    age();
    const second = run(delegationPayload(sessionId));
    age();
    const third = run(delegationPayload(sessionId));

    assert.equal(first, null, 'first delegation should not warn');
    assert.equal(second, null, 'second delegation should not warn');
    assert.ok(isWarn(third), 'third consecutive delegation should warn');
    assert.match(messageOf(third), /warnSequentialDelegations/);
    assert.match(messageOf(third), /3rd delegation/);
  } finally {
    cleanup();
  }
});

test('a marked SEQUENTIAL-JUSTIFIED prompt never warns, even at count 3', () => {
  const { sessionId, run, age, cleanup } = session();
  try {
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    age();
    const third = run(
      delegationPayload(sessionId, 'needs prior result SEQUENTIAL-JUSTIFIED'),
    );
    assert.equal(third, null);
  } finally {
    cleanup();
  }
});

test('a non-delegation tool is never warned', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const result = run({
      tool_name: 'Bash',
      session_id: sessionId,
      tool_input: { command: 'ls' },
    });
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('delegations launched together in one message are a batch, not sequential', () => {
  const { sessionId, run, cleanup } = session();
  try {
    assert.equal(run(delegationPayload(sessionId)), null);
    assert.equal(run(delegationPayload(sessionId)), null);
    assert.equal(run(delegationPayload(sessionId)), null);
    assert.equal(run(delegationPayload(sessionId)), null);
  } finally {
    cleanup();
  }
});

test('a batch counts once: two batches plus one lone delegation reach the threshold', () => {
  const { sessionId, run, age, cleanup } = session();
  try {
    run(delegationPayload(sessionId));
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    run(delegationPayload(sessionId));
    age();
    assert.ok(isWarn(run(delegationPayload(sessionId))));
  } finally {
    cleanup();
  }
});

test('a gap longer than sequentialWindowMs resets the count', () => {
  const { sessionId, run, age, cleanup } = session({
    gates: {
      warnSequentialDelegations: { enabled: true, sequentialWindowMs: 3000 },
    },
  });
  try {
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    age();
    assert.equal(run(delegationPayload(sessionId)), null);
  } finally {
    cleanup();
  }
});

test('a non-numeric sequentialThreshold falls back to the default of 3', () => {
  const { sessionId, run, age, cleanup } = session({
    gates: {
      warnSequentialDelegations: { enabled: true, sequentialThreshold: 'many' },
    },
  });
  try {
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    age();
    assert.ok(isWarn(run(delegationPayload(sessionId))));
  } finally {
    cleanup();
  }
});

test('a numeric sequentialJustifiedMarker falls back to the default marker', () => {
  const { sessionId, run, age, cleanup } = session({
    gates: {
      warnSequentialDelegations: {
        enabled: true,
        sequentialJustifiedMarker: 123,
      },
    },
  });
  try {
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    age();
    assert.ok(isWarn(run(delegationPayload(sessionId, 'needs 123'))));
  } finally {
    cleanup();
  }
});

test('without a session id the count is keyed by project, not shared globally', () => {
  const projectA = makeProject({
    config: { gates: { warnSequentialDelegations: true } },
  });
  const projectB = makeProject({
    config: { gates: { warnSequentialDelegations: true } },
  });
  const run = (project) =>
    runGateProcess(
      GATE,
      { tool_name: 'Task', tool_input: { prompt: 'x' } },
      {
        project,
      },
    );
  const age = (project) =>
    writeSessionState(
      GATE_ID,
      null,
      { count: 2, lastAt: Date.now() - SEQUENTIAL_GAP_MS },
      { cwd: project },
    );
  try {
    age(projectA);
    assert.ok(isWarn(run(projectA)));
    assert.equal(run(projectB), null);
  } finally {
    for (const project of [projectA, projectB]) {
      rmSync(dirname(stateFileFor(GATE_ID, null, { cwd: project })), {
        recursive: true,
        force: true,
      });
    }
  }
});
