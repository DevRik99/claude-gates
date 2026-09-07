import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isBlock,
  makeProject,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function setupProject({
  enabled = true,
  tasks,
  allowStopWithBlockedTasks,
} = {}) {
  const gateEntry = { enabled };
  if (allowStopWithBlockedTasks !== undefined) {
    gateEntry.allowStopWithBlockedTasks = allowStopWithBlockedTasks;
  }
  const files = {};
  if (tasks) files['.ai/tasks/active.json'] = JSON.stringify({ tasks });
  return makeProject({
    prefix: 'stop-pending-',
    config: { gates: { blockStopWithPendingTasks: gateEntry } },
    files,
  });
}

const STOP = { session_id: 's1', stop_hook_active: false };

function runGate(project, payload = STOP, cwd) {
  return runGateProcess(GATE, payload, { project, cwd });
}

const OPEN_TASK = { id: 't-1', title: 'finish the thing', status: 'open' };
const BLOCKED_TASK = {
  id: 't-2',
  title: 'waiting on X',
  status: 'blocked',
  blockedReason: 'waiting on X',
};

test('an open active task blocks the stop', () => {
  const result = runGate(setupProject({ tasks: [OPEN_TASK] }));
  assert.ok(isBlock(result));
  assert.match(messageOf(result), /t-1/);
});

test('the block message is labeled with the config key and tells how to close with verified evidence', () => {
  const message = messageOf(runGate(setupProject({ tasks: [OPEN_TASK] })));
  assert.match(message, /^\[blockStopWithPendingTasks\] /);
  assert.match(
    message,
    /task close <id> --check "<command that must exit 0>" \[--expect <text>\]/,
  );
  assert.match(
    message,
    /task close <id> --exists <path> \[--contains <text>\]/,
  );
  assert.match(message, /--note/);
  assert.match(message, /task abandon <id> --reason/);
  assert.doesNotMatch(message, /--evidence/);
});

test('no active tasks: stop is allowed', () => {
  assert.equal(runGate(setupProject({ tasks: [] })), null);
});

test('no .ai/tasks directory at all: stop is allowed', () => {
  assert.equal(runGate(setupProject({})), null);
});

test('stop_hook_active=true: always allow, even with an open task (loop guard)', () => {
  const result = runGate(setupProject({ tasks: [OPEN_TASK] }), {
    session_id: 's1',
    stop_hook_active: true,
  });
  assert.equal(result, null);
});

test('a blocked task with allowStopWithBlockedTasks default (true): stop is allowed', () => {
  assert.equal(runGate(setupProject({ tasks: [BLOCKED_TASK] })), null);
});

test('a blocked task with allowStopWithBlockedTasks:false: stop is blocked', () => {
  const result = runGate(
    setupProject({ tasks: [BLOCKED_TASK], allowStopWithBlockedTasks: false }),
  );
  assert.ok(isBlock(result));
  assert.match(messageOf(result), /t-2/);
});

test('gate disabled: stop is allowed even with an open task', () => {
  assert.equal(
    runGate(setupProject({ tasks: [OPEN_TASK], enabled: false })),
    null,
  );
});

test('a done task in active.json (should not normally happen) never blocks', () => {
  assert.equal(
    runGate(
      setupProject({
        tasks: [{ id: 't-3', title: 'already closed', status: 'done' }],
      }),
    ),
    null,
  );
});

test('corrupt active.json: fail-safe allow', () => {
  const project = setupProject({ tasks: [] });
  writeFileSync(join(project, '.ai', 'tasks', 'active.json'), '{not json');
  assert.equal(runGate(project), null);
});

// ── Robustness and protocol ─────────────────────────────────────────────────────────
test('a null or non-object task entry is tolerated; the valid open task still blocks', () => {
  const result = runGate(
    setupProject({ tasks: [null, 42, 'oops', OPEN_TASK] }),
  );
  assert.ok(isBlock(result));
  assert.match(messageOf(result), /t-1/);
});

test('the task store is found from a subdirectory of the project', () => {
  const project = setupProject({ tasks: [OPEN_TASK] });
  const sub = join(project, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.ok(isBlock(runGate(project, STOP, sub)));
});

test('dump-defaults protocol: prints the descriptor with allowStopWithBlockedTasks', () => {
  const result = runGateProcess(GATE, '', {
    environment: { CLAUDE_GATES_DUMP_DEFAULTS: '1' },
  });
  assert.equal(result.configKey, 'blockStopWithPendingTasks');
  assert.equal(result.enabledByDefault, true);
  assert.deepEqual(result.defaultParams, { allowStopWithBlockedTasks: true });
});

// ── Agent isolation: another agent's work never holds this turn open ──────────────────
const ME = 'agent-one';
const STALE_CLAIM_HOURS = 9;

function claimed(id, owner, claimedAt = new Date().toISOString()) {
  return { id, title: `work ${id}`, status: 'open', owner, claimedAt };
}

function runAs(tasks, sessionId = ME) {
  return runGate(setupProject({ tasks }), {
    session_id: sessionId,
    stop_hook_active: false,
  });
}

test("ANOTHER agent's live task does not stop this one from ending its turn", () => {
  assert.equal(runAs([claimed('t1', 'agent-two')]), null);
});

test('your own task does hold the turn', () => {
  const result = runAs([claimed('t1', ME)]);
  assert.ok(isBlock(result));
  assert.match(messageOf(result), /t1/);
});

test('an unclaimed task holds whoever is acting', () => {
  // Because free means "nobody has taken it yet", not "blocks no one": exempting it would
  // switch the gate off silently for any project written before claims existed.
  const result = runAs([{ id: 't1', title: 'suelta', status: 'open' }]);
  assert.ok(isBlock(result));
  assert.match(messageOf(result), /unclaimed/);
});

test("another agent's expired claim holds this one again", () => {
  // Because an agent that stops without releasing would hold the queue forever.
  const stale = new Date(
    Date.now() - STALE_CLAIM_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const result = runAs([claimed('t1', 'agent-gone', stale)]);
  assert.ok(isBlock(result));
});

test('only your own are listed when both agents have tasks', () => {
  const result = runAs([claimed('ours', ME), claimed('theirs', 'agent-two')]);
  assert.ok(isBlock(result));
  assert.match(messageOf(result), /ours/);
  assert.doesNotMatch(messageOf(result), /theirs/);
});
