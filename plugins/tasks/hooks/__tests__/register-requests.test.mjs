// register-requests — UserPromptSubmit hook. Spawned as a real child process, matching how
// Claude Code invokes it, against a temp project.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openTaskStore } from '../lib/task-store.mjs';

const HOOK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'register-requests.mjs',
);

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'register-requests-'));
  mkdirSync(join(project, '.git'));
  return project;
}

function runHook(cwd) {
  return execFileSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

function writeConfig(project, gates) {
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify({ gates }));
}

function sampleTask(id) {
  return {
    id,
    title: `task ${id}`,
    description: '',
    status: 'open',
    size: 'trivial',
    createdAt: new Date().toISOString(),
    messages: [],
  };
}

test('always asks the model to classify+register, even with no active tasks yet', () => {
  const project = makeProject();
  const stdout = runHook(project);
  assert.match(stdout, /claude-gates task add/);
});

test('does NOT recite active tasks before remindEveryMessages is reached', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add(sampleTask('t1'));
  writeConfig(project, {
    remindOpenTasks: { enabled: true, remindEveryMessages: 3 },
  });

  const first = runHook(project);
  assert.doesNotMatch(first, /OPEN TASKS/);
  const second = runHook(project);
  assert.doesNotMatch(second, /OPEN TASKS/);
});

test('recites active tasks once remindEveryMessages is reached, then resets the counter', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add(sampleTask('t1'));
  writeConfig(project, {
    remindOpenTasks: { enabled: true, remindEveryMessages: 2 },
  });

  runHook(project); // 1st call: counter -> 1, no reminder
  const forced = runHook(project); // 2nd call: counter hits threshold -> reminder + reset
  assert.match(forced, /OPEN TASKS/);
  assert.match(forced, /t1/);

  const afterReset = runHook(project); // 3rd call: counter just reset -> no reminder yet
  assert.doesNotMatch(afterReset, /OPEN TASKS/);
});

test('remindOpenTasks:false silences the hook entirely (no classify prompt, no reminder)', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add(sampleTask('t1'));
  writeConfig(project, { remindOpenTasks: false });

  const stdout = runHook(project);
  assert.equal(stdout, '');
});

test('defaults-dump mode reports remindEveryMessages default without touching stdin', () => {
  const out = execFileSync(process.execPath, [HOOK_PATH], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_GATES_DUMP_DEFAULTS: '1' },
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.configKey, 'remindOpenTasks');
  assert.equal(parsed.defaultParams.remindEveryMessages, 5);
});

// ── El recordatorio reparte por accionabilidad, no por orden de llegada ───────────────
const ME = 'agent-yo';
const OTHER = 'agent-otro';

function runHookAs(cwd, sessionId) {
  return execFileSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ cwd, session_id: sessionId }),
    encoding: 'utf8',
  });
}

function claimedTask(id, owner) {
  return {
    ...sampleTask(id),
    owner,
    claimedAt: new Date().toISOString(),
  };
}

function forceReminder(project, tasks) {
  const store = openTaskStore(project);
  for (const task of tasks) store.add(task);
  store.setCounter(99);
  return runHookAs(project, ME);
}

test('el recordatorio separa lo tuyo, lo libre y lo de otros', () => {
  const project = makeProject();
  const output = forceReminder(project, [
    claimedTask('ours', ME),
    sampleTask('free'),
    claimedTask('theirs', OTHER),
  ]);

  assert.match(output, /YOURS to finish or park \(1\)/);
  assert.match(output, /FREE to take/);
  assert.match(output, /HELD by 1 other agent\(s\): 1 task\(s\)/);
});

// Antes la lista era plana y se truncaba al total, asi que el backlog ajeno empujaba
// tu propio trabajo fuera del recordatorio.
test('un backlog ajeno grande no esconde tus tareas', () => {
  const project = makeProject();
  const theirs = Array.from({ length: 30 }, (_, index) =>
    claimedTask(`theirs-${String(index)}`, OTHER),
  );
  const output = forceReminder(project, [...theirs, claimedTask('ours', ME)]);

  assert.match(output, /ours/);
  assert.match(output, /HELD by 1 other agent\(s\): 30 task\(s\)/);
});

test('las tareas de otro no se listan una a una: solo se cuentan', () => {
  const project = makeProject();
  const output = forceReminder(project, [claimedTask('theirs', OTHER)]);

  assert.doesNotMatch(output, /- \[open\] theirs/);
  assert.match(output, /not yours to close/);
});

test('una tarea aparcada muestra su causa, de modo que se sepa si ya se puede retomar', () => {
  const project = makeProject();
  const parked = { ...claimedTask('parada', ME), status: 'blocked' };
  parked.blockedReason = 'esperando al usuario';
  const output = forceReminder(project, [parked]);

  assert.match(output, /blocked: esperando al usuario/);
});
