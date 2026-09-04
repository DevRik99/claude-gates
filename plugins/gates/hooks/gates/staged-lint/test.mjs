import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  isDeny,
  makeProject,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// A fake linter (cross-platform via node): exits 1 if any given file contains the word BAD.
// A stub keeps the test fast and hermetic — it exercises the gate's file scoping, not eslint.
const FAKE_LINTER = [
  'import { readFileSync } from "node:fs";',
  'const files = process.argv.slice(2);',
  'let bad = false;',
  'for (const f of files) {',
  '  if (readFileSync(f, "utf8").includes("BAD")) { console.log(`lint error in ${f}`); bad = true; }',
  '}',
  'process.exit(bad ? 1 : 0);',
].join('\n');

/** A throwaway git repo with the fake linter and the gate enabled; returns helpers. */
function makeRepo(overrides = {}) {
  const project = makeProject({
    prefix: 'staged-lint-',
    git: false,
    files: { 'fake-lint.mjs': FAKE_LINTER },
  });
  const git = (...gitArguments) =>
    spawnSync('git', gitArguments, { cwd: project, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'test');
  git('config', 'core.quotePath', 'true');
  const lintCommand = `node "${join(project, 'fake-lint.mjs')}"`;
  const writeConfig = (config) => {
    mkdirSync(join(project, '.ai'), { recursive: true });
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  };
  writeConfig({
    gates: {
      blockCommitWithStagedLintErrors: {
        enabled: true,
        lintCommand,
        ...overrides,
      },
    },
  });
  return { project, git, lintCommand, writeConfig };
}

function stage(project, git, relativePath, content) {
  mkdirSync(dirname(join(project, relativePath)), { recursive: true });
  writeFileSync(join(project, relativePath), content);
  git('add', relativePath);
}

function runGate(project, command) {
  return runGateProcess(GATE, bash(command), { project });
}

const GOOD = 'export const ok = 1;\n';
const BAD = 'export const x = "BAD";\n';

test('DENIES a commit when a staged file fails lint', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'good.mjs', GOOD);
  stage(project, git, 'bad.mjs', BAD);
  assert.ok(isDeny(runGate(project, 'git commit -m "wip"')));
});

test('allows a commit when every staged file passes lint', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'good.mjs', GOOD);
  assert.equal(runGate(project, 'git commit -m "clean"'), null);
});

test('ignores pre-existing lint debt in files you did NOT stage', () => {
  const { project, git } = makeRepo();
  writeFileSync(join(project, 'legacy.mjs'), BAD);
  stage(project, git, 'good.mjs', GOOD);
  assert.equal(
    runGate(project, 'git commit -m "clean change"'),
    null,
    'unstaged debt must never block the commit',
  );
});

test('allows when no staged file has a lintable extension', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'notes.md', 'BAD but markdown is not linted\n');
  assert.equal(runGate(project, 'git commit -m "docs"'), null);
});

test('escape hatch: [skip-lint] in the command allows a commit with failing staged lint', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'bad.mjs', BAD);
  assert.equal(runGate(project, 'git commit -m "wip [skip-lint]"'), null);
});

test('allows a non-commit command even with dirty staged files', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'bad.mjs', BAD);
  assert.equal(runGate(project, 'git status'), null);
});

test('disabled by config: the gate does not run', () => {
  const { project, git, lintCommand, writeConfig } = makeRepo();
  writeConfig({
    gates: {
      blockCommitWithStagedLintErrors: { enabled: false, lintCommand },
    },
  });
  stage(project, git, 'bad.mjs', BAD);
  assert.equal(runGate(project, 'git commit -m "wip"'), null);
});

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('git add -A && git commit lints what the add will stage, not the stale index', () => {
  const { project } = makeRepo();
  writeFileSync(join(project, 'bad.mjs'), BAD);
  assert.ok(isDeny(runGate(project, 'git add -A && git commit -m "x"')));
});

test('git commit -am lints the modified tracked files it will stage', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'tracked.mjs', GOOD);
  git('commit', '-m', 'base');
  writeFileSync(join(project, 'tracked.mjs'), BAD);
  assert.ok(isDeny(runGate(project, 'git commit -am "x"')));
});

test('a renamed and edited file is linted', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'old.mjs', GOOD);
  git('commit', '-m', 'base');
  git('mv', 'old.mjs', 'renamed.mjs');
  writeFileSync(join(project, 'renamed.mjs'), `${GOOD}${BAD}`);
  git('add', 'renamed.mjs');
  assert.ok(isDeny(runGate(project, 'git commit -m "rename"')));
});

test('a non-ASCII file name is linted verbatim', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'señal.mjs', BAD);
  assert.ok(isDeny(runGate(project, 'git commit -m "x"')));
});

test('a mention of git commit inside grep, or a --dry-run, does not lint', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'bad.mjs', BAD);
  assert.equal(runGate(project, 'grep "git commit" README.md'), null);
  assert.equal(runGate(project, 'git commit --dry-run'), null);
});

test('git.exe commit is a commit', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'bad.mjs', BAD);
  assert.ok(isDeny(runGate(project, 'git.exe commit -m "x"')));
});

test('lintExtensions without leading dots still match', () => {
  const { project, git } = makeRepo({ lintExtensions: ['mjs', 'js'] });
  stage(project, git, 'bad.mjs', BAD);
  assert.ok(isDeny(runGate(project, 'git commit -m "x"')));
});
