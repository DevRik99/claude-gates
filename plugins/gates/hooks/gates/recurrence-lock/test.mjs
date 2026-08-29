import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function newProject({ config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'recurrence-lock-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'), { recursive: true });
  if (config) {
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  return project;
}

function runGateIn(project, payload) {
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function exec() {
  return { tool_name: 'Bash', tool_input: { command: 'echo hi' } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('denies when an open recurrence class is at/above threshold', () => {
  const project = newProject();
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({
      classes: [
        { class: 'duplicate-catch', occurrences: [1, 2], status: 'open' },
      ],
    }),
  );
  assert.ok(isDeny(runGateIn(project, exec())));
});

test('allows when the recurrence class is closed', () => {
  const project = newProject();
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({
      classes: [
        { class: 'duplicate-catch', occurrences: [1, 2], status: 'closed' },
      ],
    }),
  );
  assert.equal(runGateIn(project, exec()), null);
});

test('degrades to allow when the recurrence file does not exist', () => {
  const project = newProject();
  assert.equal(runGateIn(project, exec()), null);
});

test('disabled by config: the gate does not run', () => {
  const project = newProject({
    config: { gates: { blockRegisteredRecurrences: false } },
  });
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({
      classes: [{ class: 'x', occurrences: [1, 2], status: 'open' }],
    }),
  );
  assert.equal(runGateIn(project, exec()), null);
});

test('thresholdAppearances override changes the trigger point', () => {
  const project = newProject({
    config: {
      gates: {
        blockRegisteredRecurrences: { enabled: true, thresholdAppearances: 3 },
      },
    },
  });
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({
      classes: [{ class: 'x', occurrences: [1, 2], status: 'open' }],
    }),
  );
  assert.equal(runGateIn(project, exec()), null);
});
