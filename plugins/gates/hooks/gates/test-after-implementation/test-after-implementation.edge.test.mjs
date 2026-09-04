import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeProject, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLE = { gates: { warnTestWrittenAfterImplementation: true } };

function newProject() {
  const project = makeProject({
    prefix: 'test-after-implementation-edge-',
    git: false,
    config: ENABLE,
  });
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: project });
  return project;
}

// Pairing is same-directory by design; a sibling __tests__/ layout is a known miss.
test('KNOWN LIMITATION: implementation and test in different conventional directories (src/ vs __tests__/) are never paired', () => {
  const project = newProject();
  mkdirSync(join(project, 'src'));
  mkdirSync(join(project, '__tests__'));
  writeFileSync(join(project, 'src', 'thing.js'), 'export const thing = 1;');
  assert.equal(
    runGateProcess(GATE, write(join(project, '__tests__', 'thing.test.js')), {
      project,
    }),
    null,
  );
});

// Only uncommitted changes are visible to a git-status check.
test('KNOWN LIMITATION: once the paired implementation change is committed, the gate never fires', () => {
  const project = newProject();
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  execFileSync('git', ['add', '-A'], { cwd: project });
  execFileSync('git', ['commit', '-q', '-m', 'implement thing'], {
    cwd: project,
  });
  assert.equal(
    runGateProcess(GATE, write(join(project, 'thing.test.js')), { project }),
    null,
  );
});
