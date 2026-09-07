// Every case ships with its opposite (blocks the other agent's file / lets your own through),
// because a gate that stopped firing entirely would pass half of this suite unnoticed.
// The three gate invariants are re-checked here: this one guards the write surface.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  edit,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ME = 'agent-one';
const OTHER = 'agent-two';
const STALE_HOURS = 9;
const MS_PER_HOUR = 60 * 60 * 1000;

function claimed(owns, owner, claimedAt = new Date().toISOString()) {
  return {
    id: 't-1',
    title: 'the other agent work',
    status: 'open',
    owner,
    claimedAt,
    owns,
  };
}

function project({ tasks = [], enabled = true } = {}) {
  return makeProject({
    prefix: 'file-ownership-',
    config: { gates: { blockWritesToClaimedFiles: { enabled } } },
    files: { '.ai/tasks/active.json': JSON.stringify({ tasks }) },
  });
}

function run(payload, options = {}) {
  return runGateProcess(
    GATE,
    { ...payload, session_id: options.sessionId ?? ME },
    { project: project(options) },
  );
}

test('a write to a file ANOTHER agent claimed is denied', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.ok(isDeny(result));
});

test('a write to a file YOU claimed goes through', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], ME)],
  });
  assert.equal(result, null);
});

test('a file nobody claimed is edited freely', () => {
  const result = run(write('src/other.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.equal(result, null);
});

test("another agent's task with no `owns` blocks nothing", () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [{ id: 't-1', title: 'no owns', status: 'open', owner: OTHER }],
  });
  assert.equal(result, null);
});

test('an expired claim frees the file', () => {
  // Because an agent that stops without releasing would hold its files forever.
  const stale = new Date(Date.now() - STALE_HOURS * MS_PER_HOUR).toISOString();
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER, stale)],
  });
  assert.equal(result, null);
});

test('claiming a directory covers everything beneath it', () => {
  const result = run(write('src/lib/deep/util.ts', 'x'), {
    tasks: [claimed(['src/lib'], OTHER)],
  });
  assert.ok(isDeny(result));
});

test('a claimed directory does not cover a sibling with a similar prefix', () => {
  const result = run(write('src/library.ts', 'x'), {
    tasks: [claimed(['src/lib'], OTHER)],
  });
  assert.equal(result, null);
});

test('an Edit is judged the same as a Write', () => {
  const result = run(edit('src/auth.ts', 'new'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.ok(isDeny(result));
});

test('a shell redirection into a claimed file is denied too', () => {
  const result = run(bash('echo hello > src/auth.ts'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.ok(isDeny(result));
});

test('the denial names the file, the task, the holder and the way out', () => {
  const message = messageOf(
    run(write('src/auth.ts', 'x'), {
      tasks: [claimed(['src/auth.ts'], OTHER)],
    }),
  );
  assert.match(message, /src\/auth\.ts/);
  assert.match(message, /t-1/);
  assert.match(message, new RegExp(OTHER));
  assert.match(message, /--free/);
  assert.match(message, /task claim t-1/);
});

test('a closed task no longer reserves its files', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [{ ...claimed(['src/auth.ts'], OTHER), status: 'done' }],
  });
  assert.equal(result, null);
});

test('a read-only command is never denied', () => {
  const result = run(bash('cat src/auth.ts'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.equal(result, null);
});

test("this toolkit's own remedy is never denied", () => {
  const result = run(bash('claude-gates task list --free'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.equal(result, null);
});

test('the gate stays silent when it is turned off', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
    enabled: false,
  });
  assert.equal(result, null);
});

test('a write outside the project is not compared against owns', () => {
  // Because `owns` can only name paths inside the project.
  const result = run(write('../outside.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.equal(result, null);
});
