import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function makeRepo(config) {
  const project = mkdtempSync(join(tmpdir(), 'atomic-commit-'));
  const git = (...gitArguments) =>
    spawnSync('git', gitArguments, { cwd: project, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'test');
  mkdirSync(join(project, '.ai'));
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify(config ?? { gates: { blockNonAtomicCommits: true } }),
  );
  return { project, git };
}

/** Writes a file (creating parent dirs) and stages it. */
function stage(project, git, relativePath, content = 'x\n') {
  const full = join(project, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  git('add', relativePath);
}

function runGate(project, command) {
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('DENIES a commit mixing more than maxNatures kinds (code + tests + deps)', () => {
  const { project, git } = makeRepo();
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n'); // code
  stage(project, git, 'src/a.test.mjs', 'test();\n'); // tests
  stage(project, git, 'package.json', '{"name":"x"}\n'); // deps
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
  stage(project, git, 'src/a.mjs', 'export const a = 1;\n'); // code (counts)
  stage(project, git, 'README.md', '# hi\n'); // docs (no count)
  stage(project, git, 'logo.png', 'binary\n'); // assets (no count)
  stage(project, git, 'dist/bundle.js', 'built\n'); // generated (no count)
  assert.equal(
    runGate(project, 'git commit -m "feat: a"'),
    null,
    'only code counts here → 1 nature → allowed',
  );
});

test('DENIES a commit exceeding maxFiles (counted files only)', () => {
  const { project, git } = makeRepo({
    gates: {
      blockNonAtomicCommits: { enabled: true, maxFiles: 3, maxNatures: 9 },
    },
  });
  for (let index = 0; index < 5; index += 1) {
    stage(
      project,
      git,
      `src/file${index}.mjs`,
      `export const x${index} = ${index};\n`,
    );
  }
  assert.ok(isDeny(runGate(project, 'git commit -m "big"')));
});

test('maxFiles ignores non-counted files (many docs are fine)', () => {
  const { project, git } = makeRepo({
    gates: {
      blockNonAtomicCommits: { enabled: true, maxFiles: 2, maxNatures: 9 },
    },
  });
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
