// The `task` CLI subcommands are thin wiring over task-store.mjs; these tests exercise the
// CLI surface itself (spawning `cli/index.mjs task ...` as a real child process, the way a
// user or the register-requests hook's advice actually invokes it) against a temp project,
// never against this repo's own .ai/config.json or task store.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'index.mjs',
);

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'task-cli-'));
  mkdirSync(join(project, '.git'));
  return project;
}

function runCli(arguments_, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_ENTRY, ...arguments_], {
      cwd,
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
    };
  }
}

test('task add persists a new open task under .ai/tasks/active.json', () => {
  const project = makeProject();
  const result = runCli(
    ['task', 'add', 'Fix the thing', '--description', 'details'],
    project,
  );
  assert.equal(result.code, 0, result.stderr);

  const activePath = join(project, '.ai', 'tasks', 'active.json');
  assert.ok(existsSync(activePath));
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  assert.equal(active.tasks.length, 1);
  assert.equal(active.tasks[0].title, 'Fix the thing');
  assert.equal(active.tasks[0].status, 'open');
});

test('task list shows the active task, and --all also reaches history', () => {
  const project = makeProject();
  runCli(['task', 'add', 'Task one', '--id', 't1'], project);
  runCli(['task', 'add', 'Task two', '--id', 't2'], project);
  runCli(['task', 'abandon', 't2', '--reason', 'not needed'], project);

  const active = runCli(['task', 'list'], project);
  assert.match(active.stdout, /Task one/);
  assert.doesNotMatch(active.stdout, /Task two/);

  const all = runCli(['task', 'list', '--all'], project);
  assert.match(all.stdout, /Task one/);
  assert.match(all.stdout, /Task two/);
});

test('task close WITHOUT --evidence fails and leaves the task active', () => {
  const project = makeProject();
  runCli(['task', 'add', 'Needs evidence', '--id', 't1'], project);

  const result = runCli(['task', 'close', 't1'], project);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /evidence/i);

  const activePath = join(project, '.ai', 'tasks', 'active.json');
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  assert.equal(active.tasks.length, 1, 'the task must still be active');
});

test('task close WITH --evidence succeeds and moves the task to history', () => {
  const project = makeProject();
  runCli(['task', 'add', 'Has evidence', '--id', 't1'], project);

  const result = runCli(
    ['task', 'close', 't1', '--evidence', 'npm test -> 5 passing'],
    project,
  );
  assert.equal(result.code, 0, result.stderr);

  const historyPath = join(project, '.ai', 'tasks', 'history.json');
  const history = JSON.parse(readFileSync(historyPath, 'utf8'));
  assert.equal(history.tasks.length, 1);
  assert.equal(history.tasks[0].status, 'done');
  assert.equal(history.tasks[0].evidence, 'npm test -> 5 passing');
});

test('task abandon needs no evidence and moves the task to history', () => {
  const project = makeProject();
  runCli(['task', 'add', 'Drop me', '--id', 't1'], project);

  const result = runCli(
    ['task', 'abandon', 't1', '--reason', 'obsolete'],
    project,
  );
  assert.equal(result.code, 0, result.stderr);

  const historyPath = join(project, '.ai', 'tasks', 'history.json');
  const history = JSON.parse(readFileSync(historyPath, 'utf8'));
  assert.equal(history.tasks[0].status, 'abandoned');
  assert.equal(history.tasks[0].closeReason, 'obsolete');
});

test('task promote links a forge run and keeps the task active as in_forge', () => {
  const project = makeProject();
  runCli(['task', 'add', 'Promote me', '--id', 't1'], project);

  const result = runCli(['task', 'promote', 't1', 'run-42'], project);
  assert.equal(result.code, 0, result.stderr);

  const activePath = join(project, '.ai', 'tasks', 'active.json');
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  assert.equal(active.tasks[0].status, 'in_forge');
  assert.equal(active.tasks[0].forgeRunId, 'run-42');
});
