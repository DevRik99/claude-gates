// `claude-gates task` — the CLI half of the task system. The model registers, lists,
// closes, abandons and promotes tasks through these subcommands; all persistence and the
// evidence rule live in task-store.mjs (this file is thin wiring, no rules of its own).
//
// justification: no existing tool covers this. task-store.mjs was already audited when it
// was written; this is the CLI surface on top of it, following the same pattern as
// `registry` in cli/index.mjs.

import { randomUUID } from 'node:crypto';
import {
  isFree,
  openTaskStore,
  ownerOf,
  STATUS,
} from '../plugins/tasks/hooks/lib/task-store.mjs';
import { EXIT_CODE } from './constants.mjs';
import { verifyCommand, verifyPath } from './evidence.mjs';

const DEFAULT_SIZE = 'unspecified';

// Porque una sesión de Claude Code ES un agente, su id sirve de dueño sin plomería extra.
const OWNER_ENVIRONMENT_VARIABLE = 'CLAUDE_CODE_SESSION_ID';

function callerOwner(options = {}) {
  const owner = options.session ?? process.env[OWNER_ENVIRONMENT_VARIABLE];
  return owner ? String(owner) : null;
}

function parseOwns(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

const REASON_FLAG = '--reason <text>';
const SESSION_FLAG = '--session <id>';

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
  // so that the gates can tell whose bookkeeping is whose: with several agents in one
  // project, one agent's unsplit task used to deny execution for all of them. The claim
  // shape (owner + claimedAt, expiring after CLAIM_TTL_MS) is the store's, so a dead
  // agent's reservation frees itself instead of holding the task forever.
  const owner = callerOwner(options);
  if (owner) {
    task.owner = owner;
    task.claimedAt = task.createdAt;
  }
  const owns = parseOwns(options.owns);
  if (owns.length > 0) task.owns = owns;
  if (options.parent) task.parentId = options.parent;
  store.add(task);
  process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
}

function selectTasks(store, options, caller) {
  if (options.free) return store.free();
  if (options.mine) return store.ownedBy(caller);
  if (options.all) return [...store.active(), ...store.history()];
  return store.active();
}

// Porque la pregunta real al mirar la lista es "¿puedo tomar esta?", el dueño va en cada línea.
function claimNote(task, caller) {
  const owner = ownerOf(task);
  if (!owner) return ' · free';
  if (owner === caller) return ' · yours';
  return isFree(task) ? ' · free (claim expired)' : ` · held by ${owner}`;
}

function taskList(options, { cwd = process.cwd() } = {}) {
  const store = openStoreOrFail(cwd);
  const caller = callerOwner(options);
  const tasks = selectTasks(store, options, caller);
  if (tasks.length === 0) {
    process.stdout.write('No tasks.\n');
    return;
  }
  for (const task of tasks) {
    const note = task.closedAt ? '' : claimNote(task, caller);
    process.stdout.write(`[${task.status}] ${task.id}: ${task.title}${note}\n`);
  }
}

function taskClaim(id, options, { cwd = process.cwd() } = {}) {
  const caller = callerOwner(options);
  if (!caller) {
    fail(
      `task claim needs an identity: set ${OWNER_ENVIRONMENT_VARIABLE} or pass --session <id>.`,
    );
  }
  const result = openStoreOrFail(cwd).claim(id, caller);
  if (result.error) fail(result.error);
  process.stdout.write(`${JSON.stringify(result.task, null, 2)}\n`);
}

function taskRelease(id, { cwd = process.cwd() } = {}) {
  const task = openStoreOrFail(cwd).release(id);
  if (!task) fail(`no active task with id ${id}`);
  process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
}

// Porque registerTaskCommand excedería el presupuesto de líneas del proyecto, el registro de
// claim/release vive aparte. Mismo comportamiento, mismo orden.
function registerClaimCommands(task) {
  task
    .command('list')
    .description('List active tasks, showing who holds each one.')
    .option('--all', 'include closed (done/abandoned) tasks from history')
    .option(
      '--free',
      'only tasks nobody holds right now — the ones you can take',
    )
    .option('--mine', 'only the tasks you hold')
    .option(
      SESSION_FLAG,
      `whose tasks --mine means (default: $${OWNER_ENVIRONMENT_VARIABLE})`,
    )
    .action((options) => taskList(options));

  task
    .command('claim <id>')
    .description(
      'Take a task nobody holds. Refused, naming the holder, if another agent has it.',
    )
    .option(
      SESSION_FLAG,
      `claim as this agent (default: $${OWNER_ENVIRONMENT_VARIABLE})`,
    )
    .action((id, options) => taskClaim(id, options));

  task
    .command('release <id>')
    .description(
      'Hand a task back to the free pool so another agent can take it.',
    )
    .action((id) => taskRelease(id));
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

function taskBlock(id, options, { cwd = process.cwd() } = {}) {
  const reason = String(options.reason ?? '').trim();
  if (!reason)
    fail(
      'block needs --reason "<why it cannot move forward>"; a cause is mandatory',
    );
  const store = openStoreOrFail(cwd);
  const blocked = store.block(id, reason);
  if (!blocked) fail(`no active task with id ${id}`);
  process.stdout.write(`blocked ${id}: ${reason}\n`);
}

function taskUnblock(id, { cwd = process.cwd() } = {}) {
  const store = openStoreOrFail(cwd);
  const reopened = store.unblock(id);
  if (!reopened) fail(`no active task with id ${id}`);
  process.stdout.write(`reopened ${id}\n`);
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
    .option('--owns <paths>', 'comma-separated files this task owns')
    .option(
      SESSION_FLAG,
      `owning session/agent (default: $${OWNER_ENVIRONMENT_VARIABLE}) so parallel agents do not block each other`,
    )
    .action((title, options) => taskAdd(title, options));

  registerClaimCommands(task);

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
    .option(REASON_FLAG, 'closing note')
    .action((id, options) => taskClose(id, options));

  task
    .command('abandon <id>')
    .description('Close a task as abandoned (no evidence required).')
    .option(REASON_FLAG, 'why the task was dropped')
    .action((id, options) => taskAbandon(id, options));

  task
    .command('block <id>')
    .description(
      'Park a task on a stated cause. A blocked task stops counting as pending: ' +
        'require-task-split ignores it and stop-pending lets the turn end.',
    )
    .option(REASON_FLAG, 'why it cannot move forward (required)')
    .action((id, options) => taskBlock(id, options));

  task
    .command('unblock <id>')
    .description('Return a blocked task to open.')
    .action((id) => taskUnblock(id));

  task
    .command('promote <id> <runId>')
    .description('Link a task to a forge run and mark it in_forge.')
    .action((id, runId) => taskPromote(id, runId));

  return task;
}
