import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  delegate,
  isDeny,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function projectWith(classes, config) {
  return makeProject({
    prefix: 'recurrence-lock-',
    config,
    files: {
      '.ai/reincidencias.json': JSON.stringify({ classes }),
    },
  });
}

const OPEN_CLASS = [
  { class: 'duplicate-catch', occurrences: [1, 2], status: 'open' },
];

// `echo` is now a read-only exemption, so the mutating probe is a build command.
function mutate() {
  return bash('npm run build');
}

test('denies when an open recurrence class is at/above threshold', () => {
  const project = projectWith(OPEN_CLASS);
  assert.ok(isDeny(runGateProcess(GATE, mutate(), { project })));
});

test('allows when the recurrence class is closed', () => {
  const project = projectWith([{ ...OPEN_CLASS[0], status: 'closed' }]);
  assert.equal(runGateProcess(GATE, mutate(), { project }), null);
});

test('degrades to allow when the recurrence file does not exist', () => {
  assert.equal(runGateProcess(GATE, mutate(), {}), null);
});

test('disabled by config: the gate does not run', () => {
  const project = projectWith(OPEN_CLASS, {
    gates: { blockRegisteredRecurrences: false },
  });
  assert.equal(runGateProcess(GATE, mutate(), { project }), null);
});

test('thresholdAppearances override changes the trigger point', () => {
  const project = projectWith(OPEN_CLASS, {
    gates: {
      blockRegisteredRecurrences: { enabled: true, thresholdAppearances: 3 },
    },
  });
  assert.equal(runGateProcess(GATE, mutate(), { project }), null);
});

// ── No deadlock: the remedy stays allowed ───────────────────────────────────────────
test('the Write to .ai/reincidencias.json that closes the class is allowed', () => {
  const project = projectWith(OPEN_CLASS);
  const payload = write(
    '.ai/reincidencias.json',
    JSON.stringify({ classes: [{ ...OPEN_CLASS[0], status: 'closed' }] }),
  );
  assert.equal(runGateProcess(GATE, payload, { project }), null);
  assert.equal(
    runGateProcess(
      GATE,
      write(join(project, '.ai', 'reincidencias.json'), '{}'),
      {
        project,
      },
    ),
    null,
  );
});

test('read-only shell commands are allowed while the lock is open', () => {
  const project = projectWith(OPEN_CLASS);
  for (const command of [
    'git status',
    'git log --oneline -5 && git diff HEAD~1',
    'cat .ai/reincidencias.json',
    'grep -rn "catch" src | head -20',
    'node --test plugins/x/test.mjs',
    'npm test',
    'npm run lint',
    'Get-Content .ai/reincidencias.json',
    'echo hi',
  ]) {
    assert.equal(
      runGateProcess(GATE, bash(command), { project }),
      null,
      command,
    );
  }
});

test('a read-only command that redirects into a file is not read-only', () => {
  const project = projectWith(OPEN_CLASS);
  assert.ok(
    isDeny(runGateProcess(GATE, bash('echo hi > out.txt'), { project })),
  );
  assert.ok(
    isDeny(
      runGateProcess(GATE, bash('git status && rm -rf dist'), { project }),
    ),
  );
});

test('a read-only delegation prompt is allowed; an implementation prompt is denied', () => {
  const project = projectWith(OPEN_CLASS);
  assert.equal(
    runGateProcess(
      GATE,
      delegate('Explain how the catch blocks are duplicated.'),
      {
        project,
      },
    ),
    null,
  );
  assert.ok(
    isDeny(
      runGateProcess(GATE, delegate('Implement the retry helper.'), {
        project,
      }),
    ),
  );
});

// ── State is read from the project root ─────────────────────────────────────────────
test('the recurrence file is found from a subdirectory of the project', () => {
  const project = projectWith(OPEN_CLASS);
  const sub = join(project, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.ok(isDeny(runGateProcess(GATE, mutate(), { project, cwd: sub })));
});

test('a non-numeric thresholdAppearances falls back to the default instead of silently disabling the lock', () => {
  const project = projectWith(OPEN_CLASS, {
    gates: {
      blockRegisteredRecurrences: {
        enabled: true,
        thresholdAppearances: 'abc',
      },
    },
  });
  assert.ok(isDeny(runGateProcess(GATE, mutate(), { project })));
});
