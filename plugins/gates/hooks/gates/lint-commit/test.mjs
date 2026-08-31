import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function bashPayload(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

/** Runs the gate in a temp project. HOME isolated so the real global config is not read. */
function runGate(project, payload, { enabled = true } = {}) {
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ gates: { blockCommitWithFailingLint: { enabled } } }),
  );
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function projectWithLintScript(exitCode) {
  const project = mkdtempSync(join(tmpdir(), 'lint-commit-'));
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      scripts: {
        lint: `node -e "process.exit(${exitCode})"`,
      },
    }),
  );
  return project;
}

test('lint exits non-zero: git commit is denied with tail of output', () => {
  const project = projectWithLintScript(1);
  const result = runGate(project, bashPayload('git commit -m "x"'));
  assert.ok(isDeny(result), 'expected a deny result');
  assert.match(
    result.hookSpecificOutput.permissionDecisionReason,
    /Lint failed/,
  );
});

test('lint exits zero: git commit is allowed', () => {
  const project = projectWithLintScript(0);
  const result = runGate(project, bashPayload('git commit -m "x"'));
  assert.equal(result, null);
});

test('no package.json / no lint script: commit is allowed (never invented)', () => {
  const project = mkdtempSync(join(tmpdir(), 'lint-commit-nolint-'));
  const result = runGate(project, bashPayload('git commit -m "x"'));
  assert.equal(result, null);
});

test('a non-commit shell command is never blocked, even with failing lint', () => {
  const project = projectWithLintScript(1);
  const result = runGate(project, bashPayload('git status'));
  assert.equal(result, null);
});

test('git -C <path> commit is still recognized as a commit (global-option bypass closed)', () => {
  const project = projectWithLintScript(1);
  const result = runGate(
    project,
    bashPayload(`git -C ${project} commit -m "x"`),
  );
  assert.ok(isDeny(result));
});

test('gate disabled: commit is allowed even with failing lint', () => {
  const project = projectWithLintScript(1);
  const result = runGate(project, bashPayload('git commit -m "x"'), {
    enabled: false,
  });
  assert.equal(result, null);
});
