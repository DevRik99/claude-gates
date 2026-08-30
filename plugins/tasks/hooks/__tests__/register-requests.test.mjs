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
  writeConfig(project, { remindOpenTasks: { enabled: true, remindEveryMessages: 3 } });

  const first = runHook(project);
  assert.doesNotMatch(first, /OPEN TASKS/);
  const second = runHook(project);
  assert.doesNotMatch(second, /OPEN TASKS/);
});

test('recites active tasks once remindEveryMessages is reached, then resets the counter', () => {
  const project = makeProject();
  const store = openTaskStore(project);
  store.add(sampleTask('t1'));
  writeConfig(project, { remindOpenTasks: { enabled: true, remindEveryMessages: 2 } });

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
