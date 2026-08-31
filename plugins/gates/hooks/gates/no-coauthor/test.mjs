import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'no-coauthor-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function commit(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('DENIES a commit carrying Co-Authored-By', () => {
  assert.ok(
    isDeny(
      runGate(
        commit(
          'git commit -m "fix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
        ),
      ),
    ),
  );
});

test('DENIES a commit carrying a Generated-with / session trailer', () => {
  assert.ok(
    isDeny(
      runGate(
        commit('git commit -m "feat: x\n\n🤖 Generated with Claude Code"'),
      ),
    ),
  );
  assert.ok(
    isDeny(
      runGate(
        commit(
          'git commit -m "feat: x\n\nClaude-Session: https://claude.ai/x"',
        ),
      ),
    ),
  );
});

test('DENIES the trailer through a global-option prefixed commit', () => {
  assert.ok(
    isDeny(
      runGate(
        commit('git -C /repo commit -m "x\n\nCo-Authored-By: A <a@b.c>"'),
      ),
    ),
  );
});

test('allows a clean commit message', () => {
  assert.equal(runGate(commit('git commit -m "fix: a real fix"')), null);
});

test('allows a non-commit command that merely mentions co-author', () => {
  // `git log` printing history with a co-author line must not be blocked — only a commit is.
  assert.equal(
    runGate(commit('git log --format=%b | grep "Co-Authored-By:"')),
    null,
  );
});

test('escape hatch: the marker in the command allows one legitimate co-author', () => {
  assert.equal(
    runGate(
      commit(
        'git commit -m "import history\n\nCo-Authored-By: A <a@b.c>" [allow-coauthor]',
      ),
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(commit('git commit -m "x\n\nCo-Authored-By: A <a@b.c>"'), {
      config: { gates: { blockCoauthorTrailers: false } },
    }),
    null,
  );
});

test('project attributionPatterns override replaces the built-in list', () => {
  const config = {
    gates: {
      blockCoauthorTrailers: {
        enabled: true,
        attributionPatterns: ['signed-off-by:'],
      },
    },
  };
  // Built-in Co-Authored-By is no longer in the list, so it passes.
  assert.equal(
    runGate(commit('git commit -m "x\n\nCo-Authored-By: A <a@b.c>"'), {
      config,
    }),
    null,
  );
  // The overridden pattern is enforced.
  assert.ok(
    isDeny(
      runGate(commit('git commit -m "x\n\nSigned-off-by: A <a@b.c>"'), {
        config,
      }),
    ),
  );
});
