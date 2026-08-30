// `claude-gates task` — the CLI half of the task system. The model registers, lists,
// closes, abandons and promotes tasks through these subcommands; all persistence and the
// evidence rule live in task-store.mjs (this file is thin wiring, no rules of its own).
//
// justification: no existing tool covers this. task-store.mjs was already audited when it
// was written; this is the CLI surface on top of it, following the same pattern as
// `registry` in cli/index.mjs.

import { randomUUID } from 'node:crypto';
import {
  openTaskStore,
  STATUS,
} from '../plugins/tasks/hooks/lib/task-store.mjs';
import { EXIT_CODE } from './constants.mjs';

const DEFAULT_SIZE = 'unspecified';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_CODE.FAILURE);
}

function openStoreOrFail(cwd) {
  const store = openTaskStore(cwd);
  if (!store) {
    fail(
      'No project found here (no .git or .ai/ marker): tasks need a project root.',
    );
  }
  return store;
}

function taskAdd(title, options, { cwd = process.cwd() } = {}) {
  if (!title || !title.trim()) fail('task add requires a non-empty title.');
  const store = openStoreOrFail(cwd);
  const task = store.add({
    id: options.id || randomUUID(),
    title: title.trim(),
    description: options.description ?? '',
    status: STATUS.OPEN,
    size: options.size ?? DEFAULT_SIZE,
    createdAt: new Date().toISOString(),
    messages: [],
  });
  process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
}

function taskList(options, { cwd = process.cwd() } = {}) {
  const store = openStoreOrFail(cwd);
  const tasks = options.all
    ? [...store.active(), ...store.history()]
    : store.active();
  if (tasks.length === 0) {
    process.stdout.write('No tasks.\n');
    return;
  }
  for (const task of tasks) {
    process.stdout.write(`[${task.status}] ${task.id}: ${task.title}\n`);
  }
}

function reportCloseResult(result) {
  if (result.error) fail(result.error);
  process.stdout.write(`${JSON.stringify(result.task, null, 2)}\n`);
}

function taskClose(id, options, { cwd = process.cwd() } = {}) {
  if (!options.evidence || !options.evidence.trim()) {
    fail(
      'closing a task as done requires evidence that it was attended and resolved ' +
        '(test output, a diff, a verification note). Pass --evidence, or use ' +
        '`task abandon` if it will not be finished.',
    );
  }
  const store = openStoreOrFail(cwd);
  reportCloseResult(
    store.close(id, STATUS.DONE, {
      reason: options.reason ?? '',
      evidence: options.evidence,
    }),
  );
}

function taskAbandon(id, options, { cwd = process.cwd() } = {}) {
  const store = openStoreOrFail(cwd);
  reportCloseResult(
    store.close(id, STATUS.ABANDONED, { reason: options.reason ?? '' }),
  );
}

function taskPromote(id, runId, { cwd = process.cwd() } = {}) {
  const store = openStoreOrFail(cwd);
  const promoted = store.promoteToForge(id, runId);
  if (!promoted) fail(`no active task with id ${id}`);
  process.stdout.write(`${JSON.stringify(promoted, null, 2)}\n`);
}

/** Registers the `task` command and its subcommands on a commander program. */
export function registerTaskCommand(program) {
  const task = program
    .command('task')
    .description('Track project tasks (open/blocked/in_forge/done/abandoned).');

  task
    .command('add <title>')
    .description('Register a new open task.')
    .option('--id <id>', 'explicit task id (default: a generated uuid)')
    .option('--description <text>', 'longer description of the task')
    .option('--size <size>', 'rough size estimate (e.g. trivial, small, large)')
    .action((title, options) => taskAdd(title, options));

  task
    .command('list')
    .description('List active tasks (or all with --all).')
    .option('--all', 'include closed (done/abandoned) tasks from history')
    .action((options) => taskList(options));

  task
    .command('close <id>')
    .description('Close a task as done. Requires --evidence.')
    .option(
      '--evidence <text>',
      'proof the task was attended and resolved (required)',
    )
    .option('--reason <text>', 'closing note')
    .action((id, options) => taskClose(id, options));

  task
    .command('abandon <id>')
    .description('Close a task as abandoned (no evidence required).')
    .option('--reason <text>', 'why the task was dropped')
    .action((id, options) => taskAbandon(id, options));

  task
    .command('promote <id> <runId>')
    .description('Link a task to a forge run and mark it in_forge.')
    .action((id, runId) => taskPromote(id, runId));

  return task;
}
