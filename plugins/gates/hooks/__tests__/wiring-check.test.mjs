// wiring-check — SessionStart hook. Runs against the REAL repo registry/hooks.json/disk
// (it has no per-project state of its own — it inspects the install, not the project),
// with HOME isolated only so config lookups do not read a real global config.

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
  'wiring-check.mjs',
);
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

function makeHomeOnly() {
  // wiring-check reads the registry/hooks.json relative to ITS OWN location on disk, so the
  // cwd it's given only matters for config lookup; it does not need to be a project root.
  return mkdtempSync(join(tmpdir(), 'wiring-check-home-'));
}

function runHook(cwd, home) {
  return execFileSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

test('the real repo (registry, hooks.json, disk all in sync) produces no warning', () => {
  const home = makeHomeOnly();
  const stdout = runHook(REPO_ROOT, home);
  assert.equal(stdout, '', `expected silence, got: ${stdout}`);
});

test('checkWiringOnStart:false silences the hook globally', () => {
  const home = makeHomeOnly();
  mkdirSync(join(home, '.claude', 'claude-gates'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'claude-gates', 'config.json'),
    JSON.stringify({ gates: { checkWiringOnStart: false } }),
  );
  const stdout = runHook(REPO_ROOT, home);
  assert.equal(stdout, '');
});

test('never throws even when stdin is not valid JSON', () => {
  const home = makeHomeOnly();
  const stdout = execFileSync(process.execPath, [HOOK_PATH], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(typeof stdout, 'string');
});
