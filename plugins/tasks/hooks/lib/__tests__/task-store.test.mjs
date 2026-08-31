import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openTaskStore, STATUS } from '../task-store.mjs';

// A temp project with a .git marker, so the store anchors its .ai/tasks/ there.
function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'task-store-'));
  mkdirSync(join(project, '.git'));
  return project;
}

function sampleTask(id) {
  return {
    id,
    title: `task ${id}`,
    description: 'desc',
    status: STATUS.OPEN,
    size: 'trivial',
    createdAt: new Date().toISOString(),
    messages: [],
  };
}

test('openTaskStore anchors at the nearest project marker (.ai/ counts, not only .git)', () => {
  // A project rooted only by .ai/ (no .git) must still resolve — the repo-less case.
  const project = mkdtempSync(join(tmpdir(), 'ai-only-'));
  mkdirSync(join(project, '.ai'));
  const nested = join(project, 'src', 'deep');
  mkdirSync(nested, { recursive: true });
  const store = openTaskStore(nested);
  assert.ok(
    store,
    'store resolves from a nested dir under an .ai/-rooted project',
  );
  assert.equal(store.root, project);
});

test('add and active: a new task shows up in active', () => {
  const store = openTaskStore(makeProject());
  store.add(sampleTask('t1'));
  const active = store.active();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 't1');
  assert.deepEqual(store.history(), []);
});

test('update merges fields into the active task', () => {
  const store = openTaskStore(makeProject());
  store.add(sampleTask('t1'));
  store.update('t1', { status: STATUS.BLOCKED, note: 'waiting' });
  const task = store.active()[0];
  assert.equal(task.status, STATUS.BLOCKED);
  assert.equal(task.note, 'waiting');
  assert.equal(store.update('missing', {}), null);
});

test('close MOVES a task from active to history, never deletes', () => {
  const store = openTaskStore(makeProject());
  store.add(sampleTask('t1'));
  store.add(sampleTask('t2'));

  const { task: closed } = store.close('t1', STATUS.DONE, {
    reason: 'finished',
    evidence: 'npm test -> 12 passing',
  });
  assert.equal(closed.status, STATUS.DONE);
  assert.equal(closed.closeReason, 'finished');
  assert.equal(closed.evidence, 'npm test -> 12 passing');
  assert.ok(closed.closedAt);

  assert.deepEqual(
    store.active().map((task) => task.id),
    ['t2'],
  );
  assert.deepEqual(
    store.history().map((task) => task.id),
    ['t1'],
  );
});

test('closing as done WITHOUT evidence is refused; the task stays active', () => {
  const store = openTaskStore(makeProject());
  store.add(sampleTask('t1'));
  const result = store.close('t1', STATUS.DONE, { reason: 'trust me' });
  assert.ok(result.error, 'done without evidence must return an error');
  assert.match(result.error, /evidence/i);
  assert.equal(store.active().length, 1, 'the task is not moved to history');
});

test('abandon is a terminal close: moves to history with reason, no evidence needed', () => {
  const store = openTaskStore(makeProject());
  store.add(sampleTask('t1'));
  const { task } = store.close('t1', STATUS.ABANDONED, {
    reason: 'no longer needed',
  });
  assert.equal(task.status, STATUS.ABANDONED);
  assert.equal(store.active().length, 0);
  assert.equal(store.history()[0].status, STATUS.ABANDONED);
  assert.equal(store.history()[0].closeReason, 'no longer needed');
});

test('promoteToForge links a run and keeps the task active as in_forge', () => {
  const store = openTaskStore(makeProject());
  store.add(sampleTask('t1'));
  const promoted = store.promoteToForge('t1', 'run-42');
  assert.equal(promoted.status, STATUS.IN_FORGE);
  assert.equal(promoted.forgeRunId, 'run-42');
  assert.equal(
    store.active().length,
    1,
    'in_forge is still active, not closed',
  );
});

test('close rejects a non-terminal status and an unknown id', () => {
  const store = openTaskStore(makeProject());
  store.add(sampleTask('t1'));
  assert.ok(store.close('t1', STATUS.OPEN, { reason: 'x' }).error);
  assert.ok(store.close('missing', STATUS.DONE, { evidence: 'x' }).error);
  assert.equal(store.active().length, 1);
});

test('counter persists and reads back', () => {
  const store = openTaskStore(makeProject());
  assert.equal(store.counter(), 0);
  store.setCounter(7);
  assert.equal(store.counter(), 7);
});

test('history is append-only across multiple closes', () => {
  const store = openTaskStore(makeProject());
  store.add(sampleTask('t1'));
  store.add(sampleTask('t2'));
  store.close('t1', STATUS.DONE, { reason: 'a', evidence: 'tests green' });
  store.close('t2', STATUS.ABANDONED, { reason: 'b' });
  assert.deepEqual(
    store.history().map((task) => task.id),
    ['t1', 't2'],
  );
});

test('a corrupt active.json is treated as empty, then healed by a write', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  mkdirSync(join(project, '.ai', 'tasks'), { recursive: true });
  const path = join(project, '.ai', 'tasks', 'active.json');
  writeFileSync(path, '{broken');
  assert.deepEqual(store.active(), []);
  store.add(sampleTask('t1'));
  assert.ok(existsSync(path));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 1);
});

test('a UTF-8 BOM on active.json/counter.json does not make the store treat them as empty/corrupt', () => {
  const project = makeProject();
  const tasksDirectory = join(project, '.ai', 'tasks');
  mkdirSync(tasksDirectory, { recursive: true });

  const bom = '﻿';
  writeFileSync(
    join(tasksDirectory, 'active.json'),
    bom + JSON.stringify({ tasks: [sampleTask('t1')] }),
  );
  writeFileSync(
    join(tasksDirectory, 'counter.json'),
    bom + JSON.stringify({ count: 3 }),
  );

  const store = openTaskStore(project);
  assert.deepEqual(
    store.active().map((task) => task.id),
    ['t1'],
    'a BOM-prefixed active.json must still be read as its real content, not as empty',
  );
  assert.equal(
    store.counter(),
    3,
    'a BOM-prefixed counter.json must still be read as its real value, not 0',
  );
});
