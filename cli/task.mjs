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
import { verifyCommand, verifyPath } from './evidence.mjs';

const DEFAULT_SIZE = 'unspecified';

const VERIFY_USAGE =
  'task add requires a deterministic verification criterion: ' +
  '--verify-command "<command>" [--verify-expect <text>] (command that must exit 0 when done) ' +
  'or --verify-path <path> [--verify-contains <text>] (file/dir that must exist when done). ' +
  'This defines HOW the task will be verified as complete — free text is not enough.';

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

function buildVerifyCriteria(options) {
  if (options.verifyCommand) {
    return {
      kind: 'command',
      command: options.verifyCommand,
      expect: options.verifyExpect ?? null,
    };
  }
  if (options.verifyPath) {
    return {
      kind: 'path',
      path: options.verifyPath,
      contains: options.verifyContains ?? null,
    };
  }
  return null;
}

function taskAdd(title, options, { cwd = process.cwd() } = {}) {
  if (!title || !title.trim()) fail('task add requires a non-empty title.');
  const verify = buildVerifyCriteria(options);
  if (!verify) fail(VERIFY_USAGE);
  const store = openStoreOrFail(cwd);
  const task = {
    id: options.id || randomUUID(),
    title: title.trim(),
    description: options.description ?? '',
    status: STATUS.OPEN,
    size: options.size ?? DEFAULT_SIZE,
    verify,
    createdAt: new Date().toISOString(),
    messages: [],
  };
  if (options.parent) task.parentId = options.parent;
  store.add(task);
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

const EVIDENCE_USAGE =
  'closing a task as done requires verified evidence: --check "<command>" ' +
  '[--expect <text>] (the command must exit 0) or --exists <path> [--contains <text>]. ' +
  'Free text (--evidence/--note) is only a note. Use `task abandon` if it will not be finished.';

function collectEvidence(options, cwd) {
  if (options.check) {
    return verifyCommand(options.check, { cwd, expect: options.expect });
  }
  if (options.exists) {
    return verifyPath(options.exists, { cwd, contains: options.contains });
  }
  return null;
}

function autoVerifyFromTask(task, cwd) {
  if (!task?.verify) return null;
  const { kind, command, expect, path, contains } = task.verify;
  if (kind === 'command' && command) {
    return verifyCommand(command, { cwd, expect: expect ?? undefined });
  }
  if (kind === 'path' && path) {
    return verifyPath(path, { cwd, contains: contains ?? undefined });
  }
  return null;
}

function taskClose(id, options, { cwd = process.cwd() } = {}) {
  const store = openStoreOrFail(cwd);
  let evidence = collectEvidence(options, store.root);
  if (!evidence && options.evidence !== undefined) fail(EVIDENCE_USAGE);
  if (!evidence) {
    const task = store.active().find((entry) => entry.id === id);
    evidence = autoVerifyFromTask(task, store.root);
  }
  if (!evidence) fail(EVIDENCE_USAGE);
  if (!evidence.verified) {
    const output = evidence.outputTail ? `\n${evidence.outputTail}` : '';
    fail(
      `evidence did not verify (${evidence.failure}); the task stays open.${output}`,
    );
  }
  const note = options.note ?? options.evidence ?? '';
  reportCloseResult(
    store.close(id, STATUS.DONE, {
      reason: options.reason ?? '',
      evidence: note ? { ...evidence, note } : evidence,
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
    .description(
      'Register a new open task (requires a verification criterion).',
    )
    .option('--id <id>', 'explicit task id (default: a generated uuid)')
    .option('--description <text>', 'longer description of the task')
    .option('--size <size>', 'rough size estimate (e.g. trivial, small, large)')
    .option(
      '--verify-command <command>',
      'shell command that must exit 0 when the task is done',
    )
    .option(
      '--verify-expect <text>',
      'text the --verify-command output must contain',
    )
    .option(
      '--verify-path <path>',
      'file or directory that must exist when the task is done',
    )
    .option(
      '--verify-contains <text>',
      'text the --verify-path file must contain',
    )
    .option('--parent <id>', 'parent task id (makes this a sub-task)')
    .action((title, options) => taskAdd(title, options));

  task
    .command('list')
    .description('List active tasks (or all with --all).')
    .option('--all', 'include closed (done/abandoned) tasks from history')
    .action((options) => taskList(options));

  task
    .command('close <id>')
    .description(
      'Close a task as done. Requires verified evidence: --check or --exists.',
    )
    .option(
      '--check <command>',
      'command that must exit 0 (run at the project root)',
    )
    .option('--expect <text>', 'text the --check output must contain')
    .option('--exists <path>', 'file or directory that must exist')
    .option('--contains <text>', 'text the --exists file must contain')
    .option('--note <text>', 'free-text context stored with the evidence')
    .option(
      '--evidence <text>',
      'alias of --note (free text alone is not evidence)',
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
