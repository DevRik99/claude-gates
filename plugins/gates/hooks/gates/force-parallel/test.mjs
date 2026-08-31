import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const STATE_ROOT = join(tmpdir(), 'claude-gates', 'force-parallel');

function delegationPayload(sessionId, prompt = 'do work') {
  return {
    tool_name: 'Task',
    session_id: sessionId,
    tool_input: { prompt },
  };
}

function isWarn(result) {
  return typeof result?.hookSpecificOutput?.additionalContext === 'string';
}

function runGate(project, payload) {
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ gates: { warnSequentialDelegations: { enabled: true } } }),
  );
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

test('3 sequential delegations in the same session: the 3rd warns', () => {
  const project = mkdtempSync(join(tmpdir(), 'force-parallel-'));
  const sessionId = `test-${randomUUID()}`;
  rmSync(join(STATE_ROOT, sessionId), { recursive: true, force: true });

  const first = runGate(project, delegationPayload(sessionId));
  const second = runGate(project, delegationPayload(sessionId));
  const third = runGate(project, delegationPayload(sessionId));

  assert.equal(first, null, 'first delegation should not warn');
  assert.equal(second, null, 'second delegation should not warn');
  assert.ok(isWarn(third), 'third consecutive delegation should warn');
  assert.match(third.hookSpecificOutput.additionalContext, /force-parallel/);

  rmSync(join(STATE_ROOT, sessionId), { recursive: true, force: true });
});

test('a marked SEQUENTIAL-JUSTIFIED prompt never warns, even at count 3', () => {
  const project = mkdtempSync(join(tmpdir(), 'force-parallel-'));
  const sessionId = `test-${randomUUID()}`;
  rmSync(join(STATE_ROOT, sessionId), { recursive: true, force: true });

  runGate(project, delegationPayload(sessionId));
  runGate(project, delegationPayload(sessionId));
  const third = runGate(
    project,
    delegationPayload(sessionId, 'needs prior result SEQUENTIAL-JUSTIFIED'),
  );

  assert.equal(third, null);

  rmSync(join(STATE_ROOT, sessionId), { recursive: true, force: true });
});

test('a non-delegation tool is never warned', () => {
  const project = mkdtempSync(join(tmpdir(), 'force-parallel-'));
  const sessionId = `test-${randomUUID()}`;
  rmSync(join(STATE_ROOT, sessionId), { recursive: true, force: true });

  const result = runGate(project, {
    tool_name: 'Bash',
    session_id: sessionId,
    tool_input: { command: 'ls' },
  });
  assert.equal(result, null);

  rmSync(join(STATE_ROOT, sessionId), { recursive: true, force: true });
});
