// doctor — SessionStart hook. Spawned as a real child process with a JSON payload on
// stdin, HOME isolated so the real global config is never read.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'doctor.mjs',
);

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'doctor-'));
  mkdirSync(join(project, '.git'));
  return project;
}

function runHook(cwd, { env: environment = {} } = {}) {
  return execFileSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, USERPROFILE: cwd, ...environment },
  });
}

test('stays silent when node satisfies the current engines.node and scripts are on disk', () => {
  const project = makeProject();
  const stdout = runHook(project);
  assert.equal(stdout, '');
});

test('speaks when a minNodeVersion above the running node is configured', () => {
  const project = makeProject();
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: {
        validateEnvironmentOnStart: {
          enabled: true,
          minNodeVersion: '999.0.0',
        },
      },
    }),
  );
  const stdout = runHook(project);
  assert.notEqual(stdout, '');
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(payload.hookSpecificOutput.additionalContext, /999\.0\.0/);
});

test('validateEnvironmentOnStart:false in project config silences the hook even with a bad minNodeVersion', () => {
  const project = makeProject();
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: {
        validateEnvironmentOnStart: {
          enabled: false,
          minNodeVersion: '999.0.0',
        },
      },
    }),
  );
  const stdout = runHook(project);
  assert.equal(stdout, '');
});

test('never throws even when stdin is not valid JSON', () => {
  const project = makeProject();
  const stdout = execFileSync(process.execPath, [HOOK_PATH], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  assert.equal(typeof stdout, 'string');
});
