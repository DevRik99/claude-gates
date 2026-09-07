// because this gate shipped with no tests at all, it also shipped the deadlock they would
// have caught: it denied every shell command while an unsplit task existed, including
// `claude-gates task add --parent` (the remedy its own message ordered) and `task list`
// (the only way to see which task it meant). cli/__tests__/gate-invariants.test.mjs now
// enforces both exemptions across every gate; these cover this gate's own rule.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  decisionOf,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const ENABLED = { gates: { requireTaskSplitBeforeImplementing: true } };

function projectWithTasks(tasks) {
  return makeProject({
    prefix: 'require-task-split-',
    config: ENABLED,
    files: { '.ai/tasks/active.json': JSON.stringify({ tasks }) },
  });
}

const UNSPLIT_LARGE = [
  {
    id: 'big',
    title: 'a large task nobody split',
    status: 'open',
    size: 'large',
  },
];

function run(payload, project) {
  return runGateProcess(GATE, payload, { project });
}

test('denies implementation while a large task has no sub-tasks', () => {
  const result = run(
    write('src/thing.mjs', 'export const x = 1;\n'),
    projectWithTasks(UNSPLIT_LARGE),
  );
  assert.equal(decisionOf(result), 'deny');
  assert.match(messageOf(result), /need splitting/);
  assert.match(messageOf(result), /big/);
});

test('allows once the large task has sub-tasks', () => {
  const project = projectWithTasks([
    ...UNSPLIT_LARGE,
    {
      id: 'child',
      title: 'a piece',
      status: 'open',
      size: 'small',
      parentId: 'big',
    },
  ]);
  assert.equal(
    run(write('src/thing.mjs', 'export const x = 1;\n'), project),
    null,
  );
});

test('a small or trivial task never needs splitting', () => {
  const project = projectWithTasks([
    { id: 's', title: 'small one', status: 'open', size: 'small' },
  ]);
  assert.equal(run(write('src/thing.mjs', 'x'), project), null);
});

test('a project with no tasks has nothing to enforce', () => {
  const project = makeProject({
    prefix: 'require-task-split-',
    config: ENABLED,
  });
  assert.equal(run(write('src/thing.mjs', 'x'), project), null);
});

test('read-only commands stay allowed, so the block can be diagnosed', () => {
  const project = projectWithTasks(UNSPLIT_LARGE);
  for (const command of [
    'git status',
    'git log --oneline -5',
    'cat package.json',
  ])
    assert.equal(
      run(bash(command), project),
      null,
      `${command} must be allowed`,
    );
});

test("the gate's own remedy stays allowed, so its message is reachable", () => {
  const project = projectWithTasks(UNSPLIT_LARGE);
  for (const command of [
    'claude-gates task add "piece" --parent big --size small --verify-command "echo ok"',
    'node cli/index.mjs task list',
    'claude-gates task block big --reason "waiting on scope"',
  ])
    assert.equal(
      run(bash(command), project),
      null,
      `${command} must be allowed`,
    );
});

test('a genuinely mutating command is still denied', () => {
  const project = projectWithTasks(UNSPLIT_LARGE);
  assert.equal(decisionOf(run(bash('npm run build'), project)), 'deny');
});

test('a read-only head that redirects to a file is not read-only', () => {
  const project = projectWithTasks(UNSPLIT_LARGE);
  assert.equal(
    decisionOf(run(bash('cat package.json > stolen.txt'), project)),
    'deny',
  );
});

test('a blocked task stops counting, so a parked task does not lock the project', () => {
  const project = projectWithTasks([
    {
      id: 'big',
      title: 'parked on a stated cause',
      status: 'blocked',
      size: 'large',
      blockedReason: 'waiting on a scope decision',
    },
  ]);
  assert.equal(run(write('src/thing.mjs', 'x'), project), null);
});

test('dump-defaults protocol: prints the descriptor', () => {
  const result = runGateProcess(GATE, '', {
    environment: { CLAUDE_GATES_DUMP_DEFAULTS: '1' },
  });
  assert.equal(result.configKey, 'requireTaskSplitBeforeImplementing');
  assert.equal(result.enabledByDefault, true);
});

test("another agent's unsplit task does not block this one", () => {
  const project = projectWithTasks([
    {
      id: 'theirs',
      title: 'a large task owned by another agent',
      status: 'open',
      size: 'large',
      owner: 'agent-two',
      claimedAt: new Date().toISOString(),
    },
  ]);
  const payload = {
    ...write('src/mine.mjs', 'export const x = 1;\n'),
    session_id: 'agent-one',
  };
  assert.equal(
    runGateProcess(GATE, payload, { project }),
    null,
    "one agent's bookkeeping must not freeze another who is not touching the same files",
  );
});

test('your own unsplit task still blocks you', () => {
  const project = projectWithTasks([
    {
      id: 'mine',
      title: 'a large task I own',
      status: 'open',
      size: 'large',
      owner: 'agent-one',
      claimedAt: new Date().toISOString(),
    },
  ]);
  const payload = { ...write('src/mine.mjs', 'x'), session_id: 'agent-one' };
  assert.equal(decisionOf(runGateProcess(GATE, payload, { project })), 'deny');
});

test('a task with no recorded owner counts for everyone', () => {
  const project = projectWithTasks(UNSPLIT_LARGE);
  const payload = { ...write('src/mine.mjs', 'x'), session_id: 'agent-one' };
  assert.equal(
    decisionOf(runGateProcess(GATE, payload, { project })),
    'deny',
    'ignoring ownerless tasks would quietly switch the gate off for older projects',
  );
});

// ── A parent stays split once its sub-tasks are closed ────────────────────────────────
function projectWithHistory(active, history) {
  return makeProject({
    prefix: 'require-task-split-history-',
    config: ENABLED,
    files: {
      '.ai/tasks/active.json': JSON.stringify({ tasks: active }),
      '.ai/tasks/history.json': JSON.stringify({ tasks: history }),
    },
  });
}

const PARENT = {
  id: 'parent-1',
  title: 'a large task that was split',
  status: 'open',
  size: 'large',
};

test('closing every sub-task does not resurrect the parent as unsplit', () => {
  // Because closing MOVES a task out of active, reading active alone made a finished split
  // look like no split at all -- and it fired the instant you went to close the parent.
  const project = projectWithHistory(
    [PARENT],
    [{ id: 'child-1', parentId: 'parent-1', status: 'done' }],
  );
  const result = runGateProcess(GATE, write('src/x.js', 'x'), { project });
  assert.equal(result, null);
});

test('a parent that never had sub-tasks is still denied', () => {
  const project = projectWithHistory(
    [PARENT],
    [{ id: 'unrelated', parentId: 'someone-else', status: 'done' }],
  );
  const result = runGateProcess(GATE, write('src/x.js', 'x'), { project });
  assert.equal(decisionOf(result), 'deny');
});

test('an active sub-task still counts, with no history file present', () => {
  const project = projectWithTasks([
    PARENT,
    { id: 'child-1', parentId: 'parent-1', status: 'open', size: 'small' },
  ]);
  const result = runGateProcess(GATE, write('src/x.js', 'x'), { project });
  assert.equal(result, null);
});

test('a corrupt history.json is treated as empty, not as proof of a split', () => {
  const project = makeProject({
    prefix: 'require-task-split-corrupt-',
    config: ENABLED,
    files: {
      '.ai/tasks/active.json': JSON.stringify({ tasks: [PARENT] }),
      '.ai/tasks/history.json': '{ not json',
    },
  });
  const result = runGateProcess(GATE, write('src/x.js', 'x'), { project });
  assert.equal(decisionOf(result), 'deny');
});
