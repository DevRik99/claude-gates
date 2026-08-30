// session-tasks — SessionStart hook. Spawned as a real child process with a JSON payload on
// stdin, exactly as Claude Code invokes it, against a temp project (never this repo's own
// .ai/ state).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openTaskStore, STATUS } from '../lib/task-store.mjs';

const HOOK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'session-tasks.mjs',
);

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'session-tasks-'));
  mkdirSync(join(project, '.git'));
  return project;
}

function runHook(cwd) {
  return execFileSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
  });
}

function sampleTask(id, status = STATUS.OPEN) {
  return {
    id,
    title: `task ${id}`,
    description: '',
    status,
    size: 'trivial',
    createdAt: new Date().toISOString(),
    messages: [],
  };
}

test('stays silent (empty stdout) when there are no active tasks', () => {
  const project = makeProject();
  const stdout = runHook(project);
  assert.equal(stdout, '');
});

test('lists active tasks (including in_forge, marked) when some exist', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add(sampleTask('t1'));
  store.add(sampleTask('t2', STATUS.IN_FORGE));

  const stdout = runHook(project);
  assert.notEqual(stdout, '');
  const payload = JSON.parse(stdout);
  const context = payload.hookSpecificOutput.additionalContext;
  assert.match(context, /t1/);
  assert.match(context, /t2/);
  assert.match(context, /in_forge/);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
});

test('a task closed (done/abandoned) does not appear in the session-start list', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add(sampleTask('t1'));
  store.add(sampleTask('t2'));
  store.close('t2', STATUS.ABANDONED, { reason: 'dropped' });

  const stdout = runHook(project);
  const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /t1/);
  assert.doesNotMatch(context, /t2/);
});

test('listTasksOnSessionStart:false in project config silences the hook even with active tasks', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add(sampleTask('t1'));

  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: { listTasksOnSessionStart: false },
    }),
  );

  const stdout = runHook(project);
  assert.equal(stdout, '');
});
