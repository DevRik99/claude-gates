// Edge cases for circuit-breaker: identity keyed by task (not subagent_type), no trusted
// counter on disk, the no-session bucket, and override phrasing.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const GATE_ID = 'circuit-breaker';

function delegate(prompt, sessionId, extra = {}) {
  const payload = {
    tool_name: 'Agent',
    tool_input: { prompt, subagent_type: 'worker-senior', ...extra },
  };
  return sessionId === undefined ? payload : withSession(payload, sessionId);
}

const ENABLED = {
  gates: {
    requireCircuitBreakerOnDelegation: { enabled: true, retryThreshold: 3 },
  },
};

function session(config = ENABLED) {
  const project = makeProject({ config });
  const sessionId = `edge-${randomUUID()}`;
  return {
    project,
    sessionId,
    run: (payload) => runGateProcess(GATE, payload, { project }),
    cleanup: (id = sessionId) =>
      rmSync(dirname(stateFileFor(GATE_ID, id, { cwd: project })), {
        recursive: true,
        force: true,
      }),
  };
}

// Neutral wording: no override word, so each test probes only what it names.
const SAME_TASK_PROMPT = [
  'Objetivo: fix the queue backoff cap in the payment worker.',
  '',
  'QUE SI: update src/workers/payment.js to cap the backoff.',
].join('\n');

test('FIXED: varying subagent_type per retry no longer resets the counter — the key is derived from task identity', () => {
  const { sessionId, run, cleanup } = session();
  try {
    assert.equal(
      run(delegate(SAME_TASK_PROMPT, sessionId, { subagent_type: 'worker' })),
      null,
    );
    assert.equal(
      run(
        delegate(SAME_TASK_PROMPT, sessionId, {
          subagent_type: 'worker-senior',
        }),
      ),
      null,
    );
    assert.ok(
      isDeny(
        run(
          delegate(SAME_TASK_PROMPT, sessionId, { subagent_type: 'worker2' }),
        ),
      ),
    );
  } finally {
    cleanup();
  }
});

test('FIXED: forging a count field on disk no longer has any effect — there is no count field to forge', () => {
  const { project, sessionId, run, cleanup } = session();
  const statePath = stateFileFor(GATE_ID, sessionId, { cwd: project });
  try {
    run(delegate(SAME_TASK_PROMPT, sessionId));
    assert.ok(existsSync(statePath));

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const [key] = Object.keys(state);
    assert.ok(key);
    assert.equal(state[key][0].count, undefined);
    state[key][0].count = 999;
    writeFileSync(statePath, JSON.stringify(state), 'utf8');

    assert.equal(run(delegate(SAME_TASK_PROMPT, sessionId)), null);
  } finally {
    cleanup();
  }
});

test('FIXED: no session_id no longer disables the breaker — it falls back to a project-keyed bucket', () => {
  const { run, cleanup } = session();
  const prompt =
    'Objetivo: fix a one-off no-session edge case.\n\nQUE SI: update src/edge/no-session.js.';
  try {
    assert.equal(run(delegate(prompt)), null);
    assert.equal(run(delegate(prompt)), null);
    assert.ok(isDeny(run(delegate(prompt))));
  } finally {
    cleanup(null);
  }
});

test('FIXED: OVERRIDE_PATTERN no longer matches the plain word "retry" inside ordinary task vocabulary', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const retryWordingPrompt = [
      'Objetivo: fix the retry loop in the payment worker.',
      '',
      'QUE SI: update src/workers/payment.js to cap retries.',
    ].join('\n');
    assert.equal(run(delegate(retryWordingPrompt, sessionId)), null);
    assert.equal(run(delegate(retryWordingPrompt, sessionId)), null);
    assert.ok(isDeny(run(delegate(retryWordingPrompt, sessionId))));
  } finally {
    cleanup();
  }
});

test('OK: a genuine override imperative ("retry anyway") still allows and resets the counter', () => {
  const { sessionId, run, cleanup } = session();
  try {
    assert.equal(run(delegate(SAME_TASK_PROMPT, sessionId)), null);
    assert.equal(run(delegate(SAME_TASK_PROMPT, sessionId)), null);
    assert.equal(
      run(delegate(`${SAME_TASK_PROMPT}\n\nretry anyway.`, sessionId)),
      null,
    );
    assert.equal(run(delegate(SAME_TASK_PROMPT, sessionId)), null);
  } finally {
    cleanup();
  }
});

test('OK: identical prompt+subagent_type is tripped at a configured retry threshold of 3', () => {
  const { sessionId, run, cleanup } = session();
  try {
    assert.equal(run(delegate(SAME_TASK_PROMPT, sessionId)), null);
    assert.equal(run(delegate(SAME_TASK_PROMPT, sessionId)), null);
    assert.ok(isDeny(run(delegate(SAME_TASK_PROMPT, sessionId))));
  } finally {
    cleanup();
  }
});

test('DEFAULT threshold is 2: the first attempt passes, the second identical one denies and asks for help', () => {
  const { sessionId, run, cleanup } = session({
    gates: { requireCircuitBreakerOnDelegation: true },
  });
  try {
    assert.equal(run(delegate(SAME_TASK_PROMPT, sessionId)), null);
    const second = run(delegate(SAME_TASK_PROMPT, sessionId));
    assert.ok(isDeny(second));
    assert.match(messageOf(second), /ASK THE USER/);
  } finally {
    cleanup();
  }
});
