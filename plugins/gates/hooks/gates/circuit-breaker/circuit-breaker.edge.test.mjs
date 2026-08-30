// Edge-case audit for circuit-breaker. Each test demonstrates a confirmed BUG or an OK.
// State lives at os.tmpdir()/claude-gates/circuit-breaker/<sessionId>/state.json, keyed by
// subagent_type. Each test uses a fresh randomUUID session id and cleans up after itself
// so it cannot contaminate other tests or other gates.
// Run: node --test circuit-breaker.edge.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const STATE_ROOT = join(tmpdir(), 'claude-gates', 'circuit-breaker');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'circuit-breaker-edge-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
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

const ENABLED = { config: { gates: { requireCircuitBreakerOnDelegation: true } } };

function freshSession() {
  return `edge-${randomUUID()}`;
}
function cleanupSession(sessionId) {
  try {
    rmSync(join(STATE_ROOT, sessionId), { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// Deliberately avoids any OVERRIDE_PATTERN word (retry/force/insist/reintenta/forz*) --
// a prompt describing a legitimate task can innocently contain one of those words (see
// the dedicated test below), which is itself a confirmed bug, so the other tests here
// use neutral wording to isolate what they are actually probing.
const SAME_TASK_PROMPT = [
  'Objetivo: fix the queue backoff cap in the payment worker.',
  '',
  'QUE SI: update src/workers/payment.js to cap the backoff.',
].join('\n');

test('FIXED: varying subagent_type per retry no longer resets the counter — the key is derived from task identity', () => {
  // The key is now a hash of the identity signature (identityKey), not subagent_type. The
  // exact same task retried under a different subagent_type string each time lands on the
  // same key every time, so the breaker still trips.
  const sessionId = freshSession();
  try {
    assert.equal(
      runGate(delegate(SAME_TASK_PROMPT, sessionId, { subagent_type: 'worker' }), ENABLED),
      null,
    );
    assert.equal(
      runGate(delegate(SAME_TASK_PROMPT, sessionId, { subagent_type: 'worker-senior' }), ENABLED),
      null,
    );
    assert.ok(
      isDeny(runGate(delegate(SAME_TASK_PROMPT, sessionId, { subagent_type: 'worker2' }), ENABLED)),
      'third identical attempt now denies even though it used yet another subagent_type: the key follows the task, not the label',
    );
  } finally {
    cleanupSession(sessionId);
  }
});

test('FIXED: forging a count field on disk no longer has any effect — there is no count field to forge', () => {
  // The persisted shape is now a list of { signature, seenAt } occurrences with no
  // `count` field at all. The attempt count is always recomputed by counting how many
  // stored occurrences are similar to the CURRENT signature, so writing an arbitrary
  // number onto the state file (there being no such field) cannot manufacture a deny.
  const sessionId = freshSession();
  const statePath = join(STATE_ROOT, sessionId, 'state.json');
  try {
    runGate(delegate(SAME_TASK_PROMPT, sessionId), ENABLED); // one real occurrence recorded
    assert.ok(existsSync(statePath), 'sanity: state file exists after first real attempt');

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const [key] = Object.keys(state);
    assert.ok(key, 'sanity: a key was recorded');
    assert.equal(
      state[key][0].count,
      undefined,
      'the stored entry carries no count field to forge',
    );
    // Attempting to inject a forged count field has no effect: the gate never reads it.
    state[key][0].count = 999;
    writeFileSync(statePath, JSON.stringify(state), 'utf8');

    const result = runGate(delegate(SAME_TASK_PROMPT, sessionId), ENABLED);
    assert.equal(
      result,
      null,
      'the forged count field is ignored: this is only the 2nd real occurrence, below the default threshold of 3',
    );
  } finally {
    cleanupSession(sessionId);
  }
});

test('FIXED: no session_id no longer disables the breaker — it falls back to a fixed bucket', () => {
  // A payload with no session_id lands in the fixed NO_SESSION_BUCKET ("no-session")
  // directory; identityKey (a hash of the prompt's own identity) still discriminates
  // this specific task from any other task sharing that bucket.
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      prompt: 'Objetivo: fix a one-off no-session edge case.\n\nQUE SI: update src/edge/no-session.js.',
      subagent_type: 'worker-senior',
    },
  };
  try {
    assert.equal(runGate(payload, ENABLED), null);
    assert.equal(runGate(payload, ENABLED), null);
    assert.ok(
      isDeny(runGate(payload, ENABLED)),
      'third identical attempt with no session_id now denies: the fallback bucket still tracks it',
    );
  } finally {
    cleanupSession('no-session');
  }
});

test('FIXED: OVERRIDE_PATTERN no longer matches the plain word "retry" inside ordinary task vocabulary', () => {
  // OVERRIDE_PATTERN now requires an imperative phrasing (retry anyway/it/again, force
  // it/this/anyway, reintentalo, insisti, ...), not the bare word "retry"/"force"
  // appearing as normal task vocabulary. A task genuinely about retry logic no longer
  // silently defeats the breaker.
  const sessionId = freshSession();
  try {
    const retryWordingPrompt = [
      'Objetivo: fix the retry loop in the payment worker.',
      '',
      'QUE SI: update src/workers/payment.js to cap retries.',
    ].join('\n');
    assert.equal(runGate(delegate(retryWordingPrompt, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(retryWordingPrompt, sessionId), ENABLED), null);
    assert.ok(
      isDeny(runGate(delegate(retryWordingPrompt, sessionId), ENABLED)),
      'third identical relaunch now denies: "retry" as ordinary task vocabulary is no longer read as an override',
    );
  } finally {
    cleanupSession(sessionId);
  }
});

test('OK: a genuine override imperative ("retry anyway") still allows and resets the counter', () => {
  const sessionId = freshSession();
  try {
    assert.equal(runGate(delegate(SAME_TASK_PROMPT, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(SAME_TASK_PROMPT, sessionId), ENABLED), null);
    assert.equal(
      runGate(delegate(`${SAME_TASK_PROMPT}\n\nretry anyway.`, sessionId), ENABLED),
      null,
      'genuine override imperative still allows and resets',
    );
    assert.equal(
      runGate(delegate(SAME_TASK_PROMPT, sessionId), ENABLED),
      null,
      'counter was reset: the same prompt again does not deny immediately',
    );
  } finally {
    cleanupSession(sessionId);
  }
});

test('OK: identical prompt+subagent_type is tripped at the default retry threshold', () => {
  const sessionId = freshSession();
  try {
    assert.equal(runGate(delegate(SAME_TASK_PROMPT, sessionId), ENABLED), null);
    assert.equal(runGate(delegate(SAME_TASK_PROMPT, sessionId), ENABLED), null);
    assert.ok(isDeny(runGate(delegate(SAME_TASK_PROMPT, sessionId), ENABLED)));
  } finally {
    cleanupSession(sessionId);
  }
});
