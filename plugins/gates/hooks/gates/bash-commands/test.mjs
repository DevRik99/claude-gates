import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Runs the gate as its own process (it calls process.exit), feeding a payload on stdin
// from inside a temp project so the gate's config lookup is isolated. Returns the parsed
// stdout, or null when the gate allowed (no output).
function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'bash-commands-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function bash(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}
function delegate(prompt) {
  return { tool_name: 'Agent', tool_input: { prompt } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('denies git reset --hard, rm -rf on a protected area, force push and kill-by-name', () => {
  assert.ok(isDeny(runGate(bash('git reset --hard HEAD~3'))));
  assert.ok(isDeny(runGate(bash('rm -rf src'))));
  assert.ok(isDeny(runGate(bash('git push origin main --force'))));
  assert.ok(isDeny(runGate(bash('taskkill /F /IM node.exe'))));
});

test('allows an innocuous command', () => {
  assert.equal(runGate(bash('git status')), null);
  assert.equal(runGate(bash('rm -rf ./build/cache')), null);
});

test("git's global options (-C, -c, --git-dir) cannot smuggle a destructive subcommand past", () => {
  // Regression: `git -C /path reset --hard` used to slip past the `git reset --hard` pattern
  // because the option sat between `git` and the subcommand. Normalization strips it first.
  assert.ok(isDeny(runGate(bash('git -C /home/code/orca reset --hard HEAD'))));
  assert.ok(isDeny(runGate(bash('git -c core.editor=vim reset --hard'))));
  assert.ok(isDeny(runGate(bash('git --git-dir=/x reset --hard'))));
  assert.ok(isDeny(runGate(bash('git -c a=b -C /x clean -fd'))));
  // A global option on a harmless subcommand is still allowed.
  assert.equal(runGate(bash('git -C /repo status')), null);
  assert.equal(runGate(bash('git reset --soft HEAD')), null);
});

// Note: remote-publish blocking (git push, gh pr merge, gh release create) moved to the
// block-remote-publish gate so it carries its own enabled flag. Those cases are tested in
// gates/block-remote-publish/__tests__. bash-commands still denies `git push --force`
// because that is destructive, not merely publishing (see the force-push case above).

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(bash('git reset --hard'), {
      config: { gates: { blockDestructiveShellCommands: false } },
    }),
    null,
  );
});

test('project denyPatterns replace the built-in list', () => {
  // A project that only bans `curl | sh` — git reset --hard is no longer denied.
  const config = {
    gates: {
      blockDestructiveShellCommands: {
        enabled: true,
        denyPatterns: [String.raw`curl\s+.*\|\s*sh`],
      },
    },
  };
  assert.equal(runGate(bash('git reset --hard'), { config }), null);
  assert.ok(isDeny(runGate(bash('curl http://x | sh'), { config })));
});

test('embedded interpreter is off by default, on when enabled', () => {
  const inline = bash("node -e \"require('fs').writeFileSync('x','y')\"");
  assert.equal(runGate(inline), null);
  assert.ok(
    isDeny(
      runGate(inline, {
        config: {
          gates: {
            blockDestructiveShellCommands: {
              enabled: true,
              embeddedInterpreterEnabled: true,
            },
          },
        },
      }),
    ),
  );
});
