import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

/** A throwaway git repo with a fake linter and gate config wired up; returns helpers. */
function makeRepo() {
  const project = mkdtempSync(join(tmpdir(), 'staged-lint-'));
  const git = (...gitArguments) =>
    spawnSync('git', gitArguments, { cwd: project, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'test');
  mkdirSync(join(project, '.ai'));
  const lintCommand = writeFakeLinter(project);
  const writeConfig = (config) =>
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  return { project, git, lintCommand, writeConfig };
}

/** Stages a file with the given content. */
function stage(project, git, relativePath, content) {
  writeFileSync(join(project, relativePath), content);
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

// A fake linter (cross-platform via node): exits 1 if any given file contains the word BAD.
// Written into the repo so the config can point lintCommand at it. Using a stub keeps the
// test fast and hermetic — it exercises the gate's staged-file scoping, not eslint itself.
function writeFakeLinter(project) {
  const linter = join(project, 'fake-lint.mjs');
  writeFileSync(
    linter,
    [
      'import { readFileSync } from "node:fs";',
      'const files = process.argv.slice(2);',
      'let bad = false;',
      'for (const f of files) {',
      '  if (readFileSync(f, "utf8").includes("BAD")) { console.log(`lint error in ${f}`); bad = true; }',
      '}',
      'process.exit(bad ? 1 : 0);',
    ].join('\n'),
  );
  return `node "${linter}"`;
}

function enabledWith(lintCommand) {
  return {
    gates: {
      blockCommitWithStagedLintErrors: { enabled: true, lintCommand },
    },
  };
}

test('DENIES a commit when a staged file fails lint', () => {
  const { project, git, lintCommand, writeConfig } = makeRepo();
  writeConfig(enabledWith(lintCommand));
  stage(project, git, 'good.mjs', 'export const ok = 1;\n');
  stage(project, git, 'bad.mjs', 'export const x = "BAD";\n');
  assert.ok(isDeny(runGate(project, 'git commit -m "wip"')));
});

test('allows a commit when every staged file passes lint', () => {
  const { project, git, lintCommand, writeConfig } = makeRepo();
  writeConfig(enabledWith(lintCommand));
  stage(project, git, 'good.mjs', 'export const ok = 1;\n');
  assert.equal(runGate(project, 'git commit -m "clean"'), null);
});

test('ignores pre-existing lint debt in files you did NOT stage', () => {
  const { project, git, lintCommand, writeConfig } = makeRepo();
  writeConfig(enabledWith(lintCommand));
  // A dirty file exists in the tree but is NOT staged; only a clean file is staged.
  writeFileSync(join(project, 'legacy.mjs'), 'export const y = "BAD";\n');
  stage(project, git, 'good.mjs', 'export const ok = 1;\n');
  assert.equal(
    runGate(project, 'git commit -m "clean change"'),
    null,
    'unstaged debt must never block the commit',
  );
});

test('allows when no staged file has a lintable extension', () => {
  const { project, git, lintCommand, writeConfig } = makeRepo();
  writeConfig(enabledWith(lintCommand));
  stage(project, git, 'notes.md', 'BAD but markdown is not linted\n');
  assert.equal(runGate(project, 'git commit -m "docs"'), null);
});

test('escape hatch: [skip-lint] in the command allows a commit with failing staged lint', () => {
  const { project, git, lintCommand, writeConfig } = makeRepo();
  writeConfig(enabledWith(lintCommand));
  stage(project, git, 'bad.mjs', 'export const x = "BAD";\n');
  assert.equal(runGate(project, 'git commit -m "wip [skip-lint]"'), null);
});

test('allows a non-commit command even with dirty staged files', () => {
  const { project, git, lintCommand, writeConfig } = makeRepo();
  writeConfig(enabledWith(lintCommand));
  stage(project, git, 'bad.mjs', 'export const x = "BAD";\n');
  assert.equal(runGate(project, 'git status'), null);
});

test('disabled by config: the gate does not run', () => {
  const { project, git, lintCommand, writeConfig } = makeRepo();
  writeConfig({
    gates: {
      blockCommitWithStagedLintErrors: { enabled: false, lintCommand },
    },
  });
  stage(project, git, 'bad.mjs', 'export const x = "BAD";\n');
  assert.equal(runGate(project, 'git commit -m "wip"'), null);
});
