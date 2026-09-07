import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CLAIM_TTL_MS,
  openTaskStore,
  ownedPathsOf,
  STATUS,
} from '../task-store.mjs';

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
    evidence: { kind: 'command', command: 'npm test', verified: true },
  });
  assert.equal(closed.status, STATUS.DONE);
  assert.equal(closed.closeReason, 'finished');
  assert.equal(closed.evidence.verified, true);
  assert.equal(closed.evidence.command, 'npm test');
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
  assert.ok(
    store.close('missing', STATUS.DONE, { evidence: { verified: true } }).error,
  );
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
  store.close('t1', STATUS.DONE, { reason: 'a', evidence: { verified: true } });
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

// ── blocked: the escape valve the gates already honoured but nothing could reach ─────
test('block parks a task on a stated cause, and unblock returns it to open', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'stuck', status: 'open', size: 'large' });

  const blocked = store.block('t1', 'waiting on the user to publish');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockedReason, 'waiting on the user to publish');
  assert.equal(openTaskStore(project).active()[0].status, 'blocked');

  const reopened = openTaskStore(project).unblock('t1');
  assert.equal(reopened.status, 'open');
  assert.ok(
    !('blockedReason' in openTaskStore(project).active()[0]),
    'the recorded cause must not survive as a tombstone once reopened',
  );
});

test('block and unblock report a miss instead of inventing a task', () => {
  const store = openTaskStore(makeProject());
  assert.equal(store.block('nope', 'x'), null);
  assert.equal(store.unblock('nope'), null);
});

test('a write leaves no temp file behind and never a torn read', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  for (let index = 0; index < 5; index += 1)
    store.add({ id: `t${index}`, title: `task ${index}`, status: 'open' });

  const directory = join(project, '.ai', 'tasks');
  const strays = readdirSync(directory).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(
    strays,
    [],
    'the temp file must be renamed, not left behind',
  );

  const raw = readFileSync(join(directory, 'active.json'), 'utf8');
  assert.equal(JSON.parse(raw).tasks.length, 5, 'the file must parse in full');
});

test('the counter is written through the same atomic path', () => {
  const project = makeProject();
  openTaskStore(project).setCounter(7);
  assert.equal(openTaskStore(project).counter(), 7);
  const strays = readdirSync(join(project, '.ai', 'tasks')).filter((name) =>
    name.endsWith('.tmp'),
  );
  assert.deepEqual(strays, []);
});

// ── claim/lease: quien hace que, sin que nadie bloquee a nadie ───────────────────────
test('una tarea nueva sin owner esta LIBRE, no es de nadie', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'suelta', status: 'open' });

  assert.equal(store.free().length, 1);
  assert.equal(store.ownedBy('agent-a').length, 0);
});

test('claim toma una tarea libre y la saca del pool', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'suelta', status: 'open' });

  const { task, error } = store.claim('t1', 'agent-a');
  assert.equal(error, undefined);
  assert.equal(task.owner, 'agent-a');
  assert.equal(openTaskStore(project).free().length, 0);
  assert.equal(openTaskStore(project).ownedBy('agent-a').length, 1);
});

test('claim de otro agente se rechaza NOMBRANDO al dueno actual', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'suelta', status: 'open' });
  store.claim('t1', 'agent-a');

  const { task, error } = openTaskStore(project).claim('t1', 'agent-b');
  assert.equal(task, undefined);
  assert.match(error, /agent-a/);
  assert.match(error, /--free/);
});

test('re-claim de tu propia tarea no falla: renueva la reserva', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'suelta', status: 'open' });
  store.claim('t1', 'agent-a');

  const { error } = openTaskStore(project).claim('t1', 'agent-a');
  assert.equal(error, undefined);
});

// Un agente que muere sin liberar retendria su trabajo para siempre.
test('una reserva caducada vuelve a estar libre y otro agente puede tomarla', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'suelta', status: 'open' });
  store.claim('t1', 'agent-a');

  const muchLater = { now: Date.now() + CLAIM_TTL_MS + 1000 };
  assert.equal(openTaskStore(project).free(muchLater).length, 1);
  const { error } = openTaskStore(project).claim('t1', 'agent-b', muchLater);
  assert.equal(error, undefined);
  assert.equal(openTaskStore(project).ownedBy('agent-b')[0].id, 't1');
});

// Una reserva escrita antes de que existiera claimedAt no debe evaporarse.
test('una reserva sin claimedAt se respeta en vez de caducar al instante', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'legacy', status: 'open', owner: 'agent-a' });

  assert.equal(store.free().length, 0);
  assert.equal(store.ownedBy('agent-a').length, 1);
});

test('release devuelve la tarea al pool sin dejar claves muertas', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'suelta', status: 'open' });
  store.claim('t1', 'agent-a');

  openTaskStore(project).release('t1');
  const [task] = openTaskStore(project).active();
  assert.ok(!('owner' in task));
  assert.ok(!('claimedAt' in task));
  assert.equal(openTaskStore(project).free().length, 1);
});

test('las tareas de un agente no aparecen como del otro', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'mia', status: 'open' });
  store.add({ id: 't2', title: 'suya', status: 'open' });
  store.claim('t1', 'agent-a');
  store.claim('t2', 'agent-b');

  const fresh = openTaskStore(project);
  assert.deepEqual(
    fresh.ownedBy('agent-a').map((task) => task.id),
    ['t1'],
  );
  assert.deepEqual(
    fresh.ownedBy('agent-b').map((task) => task.id),
    ['t2'],
  );
  assert.equal(fresh.free().length, 0);
});

test('claim sin owner se rechaza en vez de escribir un dueno vacio', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add({ id: 't1', title: 'suelta', status: 'open' });

  assert.match(store.claim('t1', '').error, /needs an owner/);
  assert.equal(store.free().length, 1);
});

test('ownedPathsOf lee owns y tolera una tarea que no lo declara', () => {
  assert.deepEqual(ownedPathsOf({ owns: ['src/a.ts', 'src/b.ts'] }), [
    'src/a.ts',
    'src/b.ts',
  ]);
  assert.deepEqual(ownedPathsOf({}), []);
  assert.deepEqual(ownedPathsOf({ owns: 'no-es-lista' }), []);
});
