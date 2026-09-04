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

function makeRepo(config = { gates: { blockNonAtomicCommits: true } }) {
  const project = makeProject({ prefix: 'atomic-commit-', git: false, config });
  const git = (...gitArguments) =>
    spawnSync('git', gitArguments, { cwd: project, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'test');
  return { project, git };
}

function enabledWith(parameters) {
  return { gates: { blockNonAtomicCommits: { enabled: true, ...parameters } } };
}

function stage(project, git, relativePath, content = 'x\n') {
  const full = join(project, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  git('add', relativePath);
}

function runGate(project, command) {
  return runGateProcess(GATE, bash(command), { project });
}

test('DENIES a commit mixing more than maxNatures kinds (code + tests + deps)', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n');
  stage(project, git, 'src/a.test.mjs', 'test();\n');
  stage(project, git, 'package.json', '{"name":"x"}\n');
  assert.ok(isDeny(runGate(project, 'git commit -m "stuff"')));
});

test('allows a cohesive commit within maxNatures (code + its tests)', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n');
  stage(project, git, 'src/a.test.mjs', 'test();\n');
  assert.equal(runGate(project, 'git commit -m "feat: a"'), null);
});

test('docs/assets/generated do not count toward the mix', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n');
  stage(project, git, 'README.md', '# hi\n');
  stage(project, git, 'logo.png', 'binary\n');
  stage(project, git, 'dist/bundle.js', 'built\n');
  assert.equal(
    runGate(project, 'git commit -m "feat: a"'),
    null,
    'only code counts here → 1 nature → allowed',
  );
});

test('DENIES a commit exceeding maxFiles (counted files only)', () => {
  const { project, git } = makeRepo(
    enabledWith({ maxFiles: 3, maxNatures: 9 }),
  );
  for (let index = 0; index < 5; index += 1)
    stage(
      project,
      git,
      `src/file${index}.mjs`,
      `export const x${index} = 1;\n`,
    );
  assert.ok(isDeny(runGate(project, 'git commit -m "big"')));
});

test('maxFiles ignores non-counted files (many docs are fine)', () => {
  const { project, git } = makeRepo(
    enabledWith({ maxFiles: 2, maxNatures: 9 }),
  );
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n');
  for (let index = 0; index < 8; index += 1)
    stage(project, git, `docs/d${index}.md`, `# ${index}\n`);
  assert.equal(
    runGate(project, 'git commit -m "docs + one file"'),
    null,
    '8 docs do not count; only 1 counted file, under maxFiles',
  );
});

test('escape hatch [wip] allows a deliberately broad commit', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n');
  stage(project, git, 'src/a.test.mjs', 'test();\n');
  stage(project, git, 'package.json', '{"name":"x"}\n');
  assert.equal(runGate(project, 'git commit -m "everything [wip]"'), null);
});

test('an --amend is exempt (already-scoped operation)', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n');
  stage(project, git, 'src/a.test.mjs', 'test();\n');
  stage(project, git, 'package.json', '{"name":"x"}\n');
  assert.equal(runGate(project, 'git commit --amend -m "reword"'), null);
});

test('allows a non-commit command with a mixed staged set', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n');
  stage(project, git, 'package.json', '{"name":"x"}\n');
  assert.equal(runGate(project, 'git status'), null);
});

test('disabled by config: the gate does not run', () => {
  const { project, git } = makeRepo({
    gates: { blockNonAtomicCommits: false },
  });
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n');
  stage(project, git, 'src/a.test.mjs', 'test();\n');
  stage(project, git, 'package.json', '{"name":"x"}\n');
  assert.equal(runGate(project, 'git commit -m "stuff"'), null);
});

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('src/hooks/ is application code, not tooling: a React hook + component + test is 2 natures', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/hooks/useAuth.ts');
  stage(project, git, 'src/Button.tsx');
  stage(project, git, 'src/Button.test.tsx');
  assert.equal(runGate(project, 'git commit -m "feat: auth"'), null);
});

test('models/ is application code, not types: an MVC change is one nature', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/models/user.js');
  stage(project, git, 'src/controllers/user.js');
  stage(project, git, 'src/views/user.js');
  stage(project, git, 'src/routes/user.js');
  assert.equal(runGate(project, 'git commit -m "feat: users"'), null);
  stage(project, git, 'src/types/user.d.ts');
  stage(project, git, 'src/user.test.js');
  assert.ok(
    isDeny(runGate(project, 'git commit -m "feat: users"')),
    'code + types + tests is 3 natures',
  );
});

test('staged deletions count toward maxFiles', () => {
  const { project, git } = makeRepo(
    enabledWith({ maxFiles: 3, maxNatures: 9 }),
  );
  for (let index = 0; index < 5; index += 1)
    stage(project, git, `src/file${index}.mjs`);
  git('commit', '-m', 'base');
  for (let index = 0; index < 5; index += 1) git('rm', `src/file${index}.mjs`);
  assert.ok(isDeny(runGate(project, 'git commit -m "remove"')));
});

test('git add -A && git commit judges what the add will stage', () => {
  const { project, git } = makeRepo(
    enabledWith({ maxFiles: 3, maxNatures: 9 }),
  );
  // src/ is tracked first: git status collapses an untracked folder to one `src/` entry.
  stage(project, git, 'src/base.mjs');
  git('commit', '-m', 'base');
  for (let index = 0; index < 5; index += 1)
    writeFileSync(join(project, 'src', `file${index}.mjs`), 'x\n');
  assert.ok(isDeny(runGate(project, 'git add -A && git commit -m "x"')));
});

test('an --amend in a later command segment does not exempt the commit; a --dry-run is not judged', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/a.mjs');
  stage(project, git, 'src/a.test.mjs');
  stage(project, git, 'package.json', '{"name":"x"}\n');
  assert.ok(isDeny(runGate(project, 'git commit -m x && echo --amend')));
  assert.equal(runGate(project, 'git commit --dry-run'), null);
});

test('a natures override with bare strings is skipped instead of classifying everything as one', () => {
  const { project, git } = makeRepo(
    enabledWith({ natures: ['deps', 'tests'] }),
  );
  stage(project, git, 'src/a.mjs');
  stage(project, git, 'src/a.test.mjs');
  stage(project, git, 'package.json', '{"name":"x"}\n');
  assert.equal(
    runGate(project, 'git commit -m "x"'),
    null,
    'no valid nature: every file is code → 1 nature',
  );
});

test('a non-ASCII path is classified by its real name', () => {
  const { project, git } = makeRepo(enabledWith({ maxNatures: 1 }));
  stage(project, git, 'src/a.mjs');
  stage(project, git, 'señal/x.test.mjs');
  assert.ok(isDeny(runGate(project, 'git commit -m "x"')), 'code + tests');
});
