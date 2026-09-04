import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isDeny,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLE = { gates: { warnTestWrittenAfterImplementation: true } };

function git(project, ...commandArguments) {
  execFileSync('git', commandArguments, { cwd: project });
}

function newProject({ config = ENABLE, git: initGit = true } = {}) {
  const project = makeProject({
    prefix: 'test-after-implementation-',
    git: false,
    config: config ?? undefined,
  });
  if (initGit) {
    git(project, 'init', '-q');
    git(project, 'config', 'user.email', 'a@b.c');
    git(project, 'config', 'user.name', 'a');
  }
  return project;
}

function runGateIn(project, payload, cwd) {
  return runGateProcess(GATE, payload, { project, cwd });
}

const writeTest = (filePath, content = 'test content') =>
  write(filePath, content);

test('denies creating a test whose paired implementation was just modified (uncommitted)', () => {
  const project = newProject();
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  assert.ok(
    isDeny(runGateIn(project, writeTest(join(project, 'thing.test.js')))),
  );
});

test('allows creating a test with no paired uncommitted implementation', () => {
  const project = newProject();
  assert.equal(
    runGateIn(project, writeTest(join(project, 'unrelated.test.js'))),
    null,
  );
});

test('allows editing (not creating) an existing test file', () => {
  const project = newProject();
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  const testPath = join(project, 'thing.test.js');
  writeFileSync(testPath, 'existing test');
  assert.equal(runGateIn(project, writeTest(testPath)), null);
});

test('degrades to allow when not a git repo', () => {
  const project = newProject({ git: false });
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  assert.equal(
    runGateIn(project, writeTest(join(project, 'thing.test.js'))),
    null,
  );
});

test('disabled by default (registry default is false)', () => {
  const project = newProject({ config: null });
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  assert.equal(
    runGateIn(project, writeTest(join(project, 'thing.test.js'))),
    null,
  );
});

test('the escape hatch marker in the test content allows a regression test', () => {
  const project = newProject();
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  assert.equal(
    runGateIn(
      project,
      writeTest(join(project, 'thing.test.js'), '// test-after-impl:allow'),
    ),
    null,
  );
});

// ── git status parsing through the lib ──────────────────────────────────────────────
test('an untracked directory entry (`?? src/`) is expanded so the implementation inside is paired', () => {
  const project = newProject();
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'thing.js'), 'export const thing = 1;');
  assert.ok(
    isDeny(
      runGateIn(project, writeTest(join(project, 'src', 'thing.test.js'))),
    ),
  );
});

test('a staged rename pairs by the NEW path', () => {
  const project = newProject();
  writeFileSync(join(project, 'old.js'), 'export const thing = 1;');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'initial');
  git(project, 'mv', 'old.js', 'thing.js');
  assert.ok(
    isDeny(runGateIn(project, writeTest(join(project, 'thing.test.js')))),
  );
});

test('a path with spaces is read verbatim (no porcelain quoting)', () => {
  const project = newProject();
  writeFileSync(join(project, 'my thing.js'), 'export const thing = 1;');
  assert.ok(
    isDeny(runGateIn(project, writeTest(join(project, 'my thing.test.js')))),
  );
});

test('a relative test path and a subdirectory cwd both resolve against the project root', () => {
  const project = newProject();
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  const sub = join(project, 'packages');
  mkdirSync(sub);
  assert.ok(isDeny(runGateIn(project, writeTest('thing.test.js'), sub)));
});

test('a non-array implementationExtensions falls back to the defaults instead of denying', () => {
  const project = newProject({
    config: {
      gates: {
        warnTestWrittenAfterImplementation: {
          enabled: true,
          implementationExtensions: '.js',
        },
      },
    },
  });
  const result = runGateIn(
    project,
    writeTest(join(project, 'unrelated.test.js')),
  );
  assert.ok(!isDeny(result));
});
