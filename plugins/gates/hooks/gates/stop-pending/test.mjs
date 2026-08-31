import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function setupProject({
  enabled = true,
  tasks,
  allowStopWithBlockedTasks,
} = {}) {
  const project = mkdtempSync(join(tmpdir(), 'stop-pending-'));
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, '.ai'), { recursive: true });

  const gateEntry = { enabled };
  if (allowStopWithBlockedTasks !== undefined) {
    gateEntry.allowStopWithBlockedTasks = allowStopWithBlockedTasks;
  }
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ gates: { blockStopWithPendingTasks: gateEntry } }),
  );

  if (tasks) {
    mkdirSync(join(project, '.ai', 'tasks'), { recursive: true });
    writeFileSync(
      join(project, '.ai', 'tasks', 'active.json'),
      JSON.stringify({ tasks }),
    );
  }
  return project;
}

function runGate(project, payload) {
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

test('an open active task blocks the stop', () => {
  const project = setupProject({
    tasks: [{ id: 't-1', title: 'finish the thing', status: 'open' }],
  });
  const result = runGate(project, {
    session_id: 's1',
    stop_hook_active: false,
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /t-1/);
});

test('no active tasks: stop is allowed', () => {
  const project = setupProject({ tasks: [] });
  const result = runGate(project, {
    session_id: 's1',
    stop_hook_active: false,
  });
  assert.equal(result, null);
});

test('no .ai/tasks directory at all: stop is allowed', () => {
  const project = setupProject({});
  const result = runGate(project, {
    session_id: 's1',
    stop_hook_active: false,
  });
  assert.equal(result, null);
});

test('stop_hook_active=true: always allow, even with an open task (loop guard)', () => {
  const project = setupProject({
    tasks: [{ id: 't-1', title: 'finish the thing', status: 'open' }],
  });
  const result = runGate(project, { session_id: 's1', stop_hook_active: true });
  assert.equal(result, null);
});

test('a blocked task with allowStopWithBlockedTasks default (true): stop is allowed', () => {
  const project = setupProject({
    tasks: [
      {
        id: 't-2',
        title: 'waiting on X',
        status: 'blocked',
        blockedReason: 'waiting on X',
      },
    ],
  });
  const result = runGate(project, {
    session_id: 's1',
    stop_hook_active: false,
  });
  assert.equal(result, null);
});

test('a blocked task with allowStopWithBlockedTasks:false: stop is blocked', () => {
  const project = setupProject({
    tasks: [
      {
        id: 't-2',
        title: 'waiting on X',
        status: 'blocked',
        blockedReason: 'waiting on X',
      },
    ],
    allowStopWithBlockedTasks: false,
  });
  const result = runGate(project, {
    session_id: 's1',
    stop_hook_active: false,
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /t-2/);
});

test('gate disabled: stop is allowed even with an open task', () => {
  const project = setupProject({
    tasks: [{ id: 't-1', title: 'finish the thing', status: 'open' }],
    enabled: false,
  });
  const result = runGate(project, {
    session_id: 's1',
    stop_hook_active: false,
  });
  assert.equal(result, null);
});

test('a done task in active.json (should not normally happen) never blocks', () => {
  const project = setupProject({
    tasks: [{ id: 't-3', title: 'already closed', status: 'done' }],
  });
  const result = runGate(project, {
    session_id: 's1',
    stop_hook_active: false,
  });
  assert.equal(result, null);
});

test('corrupt active.json: fail-safe allow', () => {
  const project = setupProject({ tasks: [] });
  writeFileSync(join(project, '.ai', 'tasks', 'active.json'), '{not json');
  const result = runGate(project, {
    session_id: 's1',
    stop_hook_active: false,
  });
  assert.equal(result, null);
});
