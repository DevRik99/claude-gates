import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stateFileFor } from '../../lib/session-state.mjs';
import {
  isDeny,
  makeProject,
  runGateProcess,
  withSession,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const GATE_ID = 'circuit-breaker';

function delegate(prompt, sessionId, extra = {}) {
  return withSession(
    {
      tool_name: 'Agent',
      tool_input: { prompt, subagent_type: 'worker-senior', ...extra },
    },
    sessionId,
  );
}

// Tests written around a three-attempt scenario pin retryThreshold: 3 so they stay valid
// regardless of the default (2, covered by its own test in the edge file).
const ENABLED = {
  gates: {
    requireCircuitBreakerOnDelegation: { enabled: true, retryThreshold: 3 },
  },
};

function session() {
  const project = makeProject({ config: ENABLED });
  const sessionId = `test-${randomUUID()}`;
  return {
    sessionId,
    run: (payload, config) =>
      runGateProcess(GATE, payload, {
        project: config ? makeProject({ config }) : project,
      }),
    cleanup: () =>
      rmSync(dirname(stateFileFor(GATE_ID, sessionId, { cwd: project })), {
        recursive: true,
        force: true,
      }),
  };
}

const LOGIN_TASK =
  'Objetivo: fix the login redirect bug.\n\nQUE SI: update src/auth/redirect.js.';

test('cuts the same delegation retried without substantial change', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const prompt = [
      'Objetivo: fix the circuit breaker false positive in guard scoring.',
      '',
      'QUE SI: update lib/scoring.mjs to fix the Dice threshold.',
    ].join('\n');

    assert.equal(run(delegate(prompt, sessionId)), null);
    assert.equal(run(delegate(prompt, sessionId)), null);
    assert.ok(isDeny(run(delegate(prompt, sessionId))));
  } finally {
    cleanup();
  }
});

test('does not accumulate two genuinely different tasks to the same subagent', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const taskB =
      'Objetivo: migrate the billing schema to the new payments table.\n\nQUE SI: update db/migrations/billing.sql.';

    assert.equal(run(delegate(LOGIN_TASK, sessionId)), null);
    assert.equal(run(delegate(taskB, sessionId)), null);
    assert.equal(run(delegate(LOGIN_TASK, sessionId)), null);
    assert.equal(run(delegate(taskB, sessionId)), null);
  } finally {
    cleanup();
  }
});

test('the retry/force escape hatch allows and resets the counter', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const prompt =
      'Objetivo: fix the flaky test in the payment suite.\n\nQUE SI: stabilize test/payment.spec.js.';

    assert.equal(run(delegate(prompt, sessionId)), null);
    assert.equal(run(delegate(prompt, sessionId)), null);
    assert.equal(
      run(delegate(`${prompt}\n\nforce it, retry.`, sessionId)),
      null,
    );
    assert.equal(run(delegate(prompt, sessionId)), null);
  } finally {
    cleanup();
  }
});

test('bilingual control: the Spanish override imperative resets the counter exactly like its English equivalent', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const prompt =
      'Objetivo: fix the flaky test in the payment suite.\n\nQUE SI: stabilize test/payment.spec.js.';

    assert.equal(run(delegate(prompt, sessionId)), null);
    assert.equal(run(delegate(prompt, sessionId)), null);
    assert.equal(
      run(delegate(`${prompt}\n\nreintentalo, forzalo.`, sessionId)),
      null,
    );
    assert.equal(run(delegate(prompt, sessionId)), null);
  } finally {
    cleanup();
  }
});

test('disabled by config: the gate does not run', () => {
  const { sessionId, run, cleanup } = session();
  const disabled = { gates: { requireCircuitBreakerOnDelegation: false } };
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(run(delegate(LOGIN_TASK, sessionId), disabled), null);
    }
  } finally {
    cleanup();
  }
});

test('project retryThreshold override cuts sooner', () => {
  const project = makeProject({
    config: {
      gates: {
        requireCircuitBreakerOnDelegation: { enabled: true, retryThreshold: 2 },
      },
    },
  });
  const sessionId = `test-${randomUUID()}`;
  const run = (payload) => runGateProcess(GATE, payload, { project });
  try {
    assert.equal(run(delegate(LOGIN_TASK, sessionId)), null);
    assert.ok(isDeny(run(delegate(LOGIN_TASK, sessionId))));
  } finally {
    rmSync(dirname(stateFileFor(GATE_ID, sessionId, { cwd: project })), {
      recursive: true,
      force: true,
    });
  }
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('a one-word change is still the same task: similarity counts across keys', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const first =
      'Objetivo: fix the queue backoff cap in the payment worker.\n\nQUE SI: update src/workers/payment.js to cap the backoff.';
    const reworded =
      'Objetivo: fix the task backoff cap in the payment worker.\n\nQUE SI: update src/workers/payment.js to cap the backoff.';
    assert.equal(run(delegate(first, sessionId)), null);
    assert.equal(run(delegate(reworded, sessionId)), null);
    assert.ok(isDeny(run(delegate(first, sessionId))));
  } finally {
    cleanup();
  }
});

test('a numeric session_id does not crash the gate', () => {
  const project = makeProject({ config: ENABLED });
  const run = (payload) => runGateProcess(GATE, payload, { project });
  try {
    assert.equal(run(delegate(LOGIN_TASK, 12345)), null);
    assert.equal(run(delegate(LOGIN_TASK, 12345)), null);
    assert.ok(isDeny(run(delegate(LOGIN_TASK, 12345))));
  } finally {
    rmSync(dirname(stateFileFor(GATE_ID, '12345', { cwd: project })), {
      recursive: true,
      force: true,
    });
  }
});

test('a path-traversal session_id cannot write outside the state root', () => {
  const project = makeProject({ config: ENABLED });
  const traversal = `../../escaped-${randomUUID()}`;
  const escapedDirectory = join(tmpdir(), traversal.split('/').at(-1));
  try {
    runGateProcess(GATE, delegate(LOGIN_TASK, traversal), { project });
    assert.ok(!existsSync(escapedDirectory));
    assert.ok(existsSync(stateFileFor(GATE_ID, traversal, { cwd: project })));
  } finally {
    rmSync(dirname(stateFileFor(GATE_ID, traversal, { cwd: project })), {
      recursive: true,
      force: true,
    });
  }
});

test('retryThreshold below 2 is treated as 2: the first attempt never denies', () => {
  for (const retryThreshold of [0, 1]) {
    const project = makeProject({
      config: {
        gates: {
          requireCircuitBreakerOnDelegation: { enabled: true, retryThreshold },
        },
      },
    });
    const sessionId = `test-${randomUUID()}`;
    const run = (payload) => runGateProcess(GATE, payload, { project });
    try {
      assert.equal(run(delegate(LOGIN_TASK, sessionId)), null);
      assert.ok(isDeny(run(delegate(LOGIN_TASK, sessionId))));
    } finally {
      rmSync(dirname(stateFileFor(GATE_ID, sessionId, { cwd: project })), {
        recursive: true,
        force: true,
      });
    }
  }
});

test('an override imperative inside a long instruction is task vocabulary, not an override', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const prompt =
      'Objetivo: harden the staging database client.\n\nQUE SI: update src/db/client.js. ' +
      'Also force it to use TLS when connecting to the staging database so that the handshake passes.';
    assert.equal(run(delegate(prompt, sessionId)), null);
    assert.equal(run(delegate(prompt, sessionId)), null);
    assert.ok(isDeny(run(delegate(prompt, sessionId))));
  } finally {
    cleanup();
  }
});

test('the IN SCOPE content on the heading line itself is part of the task identity', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const taskA =
      'Objetivo: refactor the module.\nQUE SI: update src/auth/login.js and the session cookie parser.';
    const taskB =
      'Objetivo: refactor the module.\nQUE SI: update db/migrations/billing.sql and the invoice totals.';
    assert.equal(run(delegate(taskA, sessionId)), null);
    assert.equal(run(delegate(taskB, sessionId)), null);
    assert.equal(run(delegate(taskA, sessionId)), null);
  } finally {
    cleanup();
  }
});

test('accents do not change the task identity', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const accented =
      'Objetivo: corregir la validación del correo electrónico.\n\nQUE SI: actualizar src/validación/correo.js.';
    const plain =
      'Objetivo: corregir la validacion del correo electronico.\n\nQUE SI: actualizar src/validacion/correo.js.';
    assert.equal(run(delegate(accented, sessionId)), null);
    assert.equal(run(delegate(plain, sessionId)), null);
    assert.ok(isDeny(run(delegate(accented, sessionId))));
  } finally {
    cleanup();
  }
});
