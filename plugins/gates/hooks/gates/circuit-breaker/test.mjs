import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const STATE_ROOT = join(tmpdir(), 'claude-gates', 'circuit-breaker');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'circuit-breaker-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function delegate(prompt, sessionId, extra = {}) {
  return {
    tool_name: 'Agent',
    session_id: sessionId,
    tool_input: { prompt, subagent_type: 'worker-senior', ...extra },
  };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLED = {
  config: { gates: { requireCircuitBreakerOnDelegation: true } },
};

function freshSession() {
  return `test-${randomUUID()}`;
}

function cleanupSession(sessionId) {
  try {
    rmSync(join(STATE_ROOT, sessionId), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

test('cuts the same delegation retried without substantial change', () => {
  const sessionId = freshSession();
  try {
    const prompt = [
      'Objetivo: fix the circuit breaker false positive in guard scoring.',
      '',
      'QUE SI: update lib/scoring.mjs to fix the Dice threshold.',
    ].join('\n');

    assert.equal(runGate(delegate(prompt, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(prompt, sessionId), ENABLED), null);
    assert.ok(isDeny(runGate(delegate(prompt, sessionId), ENABLED)));
  } finally {
    cleanupSession(sessionId);
  }
});

test('does not accumulate two genuinely different tasks to the same subagent', () => {
  const sessionId = freshSession();
  try {
    const taskA =
      'Objetivo: fix the login redirect bug.\n\nQUE SI: update src/auth/redirect.js.';
    const taskB =
      'Objetivo: migrate the billing schema to the new payments table.\n\nQUE SI: update db/migrations/billing.sql.';

    assert.equal(runGate(delegate(taskA, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(taskB, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(taskA, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(taskB, sessionId), ENABLED), null);
  } finally {
    cleanupSession(sessionId);
  }
});

test('the retry/force escape hatch allows and resets the counter', () => {
  const sessionId = freshSession();
  try {
    const prompt =
      'Objetivo: fix the flaky test in the payment suite.\n\nQUE SI: stabilize test/payment.spec.js.';

    assert.equal(runGate(delegate(prompt, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(prompt, sessionId), ENABLED), null);
    assert.equal(
      runGate(delegate(`${prompt}\n\nforce it, retry.`, sessionId), ENABLED),
      null,
    );
    // Counter was reset: the same prompt again should not deny immediately.
    assert.equal(runGate(delegate(prompt, sessionId), ENABLED), null);
  } finally {
    cleanupSession(sessionId);
  }
});

test('bilingual control: the Spanish override imperative resets the counter exactly like its English equivalent', () => {
  const sessionId = freshSession();
  try {
    const prompt =
      'Objetivo: fix the flaky test in the payment suite.\n\nQUE SI: stabilize test/payment.spec.js.';

    assert.equal(runGate(delegate(prompt, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(prompt, sessionId), ENABLED), null);
    assert.equal(
      runGate(delegate(`${prompt}\n\nreintentalo, forzalo.`, sessionId), ENABLED),
      null,
    );
    assert.equal(runGate(delegate(prompt, sessionId), ENABLED), null);
  } finally {
    cleanupSession(sessionId);
  }
});

test('disabled by config: the gate does not run', () => {
  const sessionId = freshSession();
  try {
    const prompt =
      'Objetivo: fix the login redirect bug.\n\nQUE SI: update src/auth/redirect.js.';
    const disabled = {
      config: { gates: { requireCircuitBreakerOnDelegation: false } },
    };
    assert.equal(runGate(delegate(prompt, sessionId), disabled), null);
    assert.equal(runGate(delegate(prompt, sessionId), disabled), null);
    assert.equal(runGate(delegate(prompt, sessionId), disabled), null);
    assert.equal(runGate(delegate(prompt, sessionId), disabled), null);
  } finally {
    cleanupSession(sessionId);
  }
});

test('project retryThreshold override cuts sooner', () => {
  const sessionId = freshSession();
  try {
    const config = {
      gates: {
        requireCircuitBreakerOnDelegation: { enabled: true, retryThreshold: 2 },
      },
    };
    const prompt =
      'Objetivo: fix the login redirect bug.\n\nQUE SI: update src/auth/redirect.js.';
    assert.equal(runGate(delegate(prompt, sessionId), { config }), null);
    assert.ok(isDeny(runGate(delegate(prompt, sessionId), { config })));
  } finally {
    cleanupSession(sessionId);
  }
});
