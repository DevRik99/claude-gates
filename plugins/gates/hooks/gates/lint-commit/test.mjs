import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(project, payload, { enabled = true, cwd, extra = {} } = {}) {
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: { blockCommitWithFailingLint: { enabled, ...extra } },
    }),
  );
  return runGateProcess(GATE, payload, { project, cwd });
}

function projectWithLintScript(exitCode) {
  return makeProject({
    prefix: 'lint-commit-',
    config: {},
    files: {
      'package.json': JSON.stringify({
        name: 'fixture',
        scripts: { lint: `node -e "process.exit(${exitCode})"` },
      }),
    },
  });
}

test('lint exits non-zero: git commit is denied with tail of output', () => {
  const project = projectWithLintScript(1);
  const result = runGate(project, bash('git commit -m "x"'));
  assert.ok(isDeny(result), 'expected a deny result');
  assert.match(messageOf(result), /Lint failed/);
});

test('lint exits zero: git commit is allowed', () => {
  const project = projectWithLintScript(0);
  assert.equal(runGate(project, bash('git commit -m "x"')), null);
});

test('no package.json / no lint script: commit is allowed (never invented)', () => {
  const project = makeProject({ prefix: 'lint-commit-nolint-', config: {} });
  assert.equal(runGate(project, bash('git commit -m "x"')), null);
});

test('a non-commit shell command is never blocked, even with failing lint', () => {
  const project = projectWithLintScript(1);
  assert.equal(runGate(project, bash('git status')), null);
});

test('git -C <path> commit is still recognized as a commit (global-option bypass closed)', () => {
  const project = projectWithLintScript(1);
  assert.ok(isDeny(runGate(project, bash(`git -C ${project} commit -m "x"`))));
});

test('gate disabled: commit is allowed even with failing lint', () => {
  const project = projectWithLintScript(1);
  assert.equal(
    runGate(project, bash('git commit -m "x"'), { enabled: false }),
    null,
  );
});

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('a mention of git commit inside grep or echo does not run lint', () => {
  const project = projectWithLintScript(1);
  assert.equal(runGate(project, bash('grep "git commit" README.md')), null);
  assert.equal(runGate(project, bash('echo "git commit -m x"')), null);
});

test('git commit --dry-run and git commit-tree do not run lint', () => {
  const project = projectWithLintScript(1);
  assert.equal(runGate(project, bash('git commit --dry-run')), null);
  assert.equal(runGate(project, bash('git commit-tree HEAD^{tree}')), null);
});

test('git.exe commit is a commit', () => {
  const project = projectWithLintScript(1);
  assert.ok(isDeny(runGate(project, bash('git.exe commit -m "x"'))));
});

test('git -C <other repo> commit lints THAT repo, not the cwd', () => {
  const clean = projectWithLintScript(0);
  const dirty = projectWithLintScript(1);
  assert.ok(
    isDeny(runGate(clean, bash(`git -C "${dirty}" commit -m "x"`))),
    'the dirty repo named by -C is what gets linted',
  );
  assert.equal(
    runGate(dirty, bash(`git -C "${clean}" commit -m "x"`)),
    null,
    'the clean repo named by -C passes even though the cwd repo fails',
  );
});

test('a commit from a subfolder lints the project root, where package.json lives', () => {
  const project = projectWithLintScript(1);
  mkdirSync(join(project, 'sub'));
  assert.ok(
    isDeny(
      runGate(project, bash('git commit -m "x"'), {
        cwd: join(project, 'sub'),
      }),
    ),
  );
});

test('a wrong-typed lintCommand falls back to autodetection instead of crashing', () => {
  const project = projectWithLintScript(1);
  assert.ok(
    isDeny(
      runGate(project, bash('git commit -m "x"'), {
        extra: { lintCommand: true },
      }),
    ),
  );
});
