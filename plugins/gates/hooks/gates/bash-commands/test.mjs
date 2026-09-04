import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  delegate,
  isDeny,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
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
  assert.ok(isDeny(runGate(bash('git -C /home/code/orca reset --hard HEAD'))));
  assert.ok(isDeny(runGate(bash('git -c core.editor=vim reset --hard'))));
  assert.ok(isDeny(runGate(bash('git --git-dir=/x reset --hard'))));
  assert.ok(isDeny(runGate(bash('git -c a=b -C /x clean -fd'))));
  assert.equal(runGate(bash('git -C /repo status')), null);
  assert.equal(runGate(bash('git reset --soft HEAD')), null);
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(bash('git reset --hard'), {
      config: { gates: { blockDestructiveShellCommands: false } },
    }),
    null,
  );
});

test('project denyPatterns replace the built-in list', () => {
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

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('rm -rf over the root slash or a bare star is denied', () => {
  assert.ok(isDeny(runGate(bash('rm -rf /'))));
  assert.ok(isDeny(runGate(bash('rm -rf *'))));
});

test('rm -rf on a path that merely starts like a protected area is allowed', () => {
  assert.equal(runGate(bash('rm -rf /tmp/build-cache')), null);
  assert.equal(runGate(bash('rm -rf src-old')), null);
});

test('every spelling of recursive+force flags is caught', () => {
  for (const command of [
    'rm -fr src',
    'rm -r -f src',
    'rm -rf -- src',
    'rm -rf "src"',
    'rm -rf -v src',
    'rm -rfv src',
    'rm --recursive --force src',
    'rm -Rf ./src',
    'rm -rf src/',
  ]) {
    assert.ok(isDeny(runGate(bash(command))), `${command} must be denied`);
  }
  assert.equal(runGate(bash('rm -r src')), null, 'no force flag: allowed');
});

test('the rm rule names the target and the protected areas', () => {
  const result = runGate(bash('rm -rf tests'));
  assert.match(messageOf(result), /'tests'/);
  assert.match(messageOf(result), /rmRfProtectedAreas/);
});

test('rmRfProtectedAreas [] turns the rm rule off', () => {
  const config = {
    gates: {
      blockDestructiveShellCommands: { enabled: true, rmRfProtectedAreas: [] },
    },
  };
  assert.equal(runGate(bash('rm -rf src'), { config }), null);
});

test('force push via -f or a +refspec is denied; --force-with-lease is allowed', () => {
  assert.ok(isDeny(runGate(bash('git push -f origin main'))));
  assert.ok(isDeny(runGate(bash('git push origin +main'))));
  assert.equal(runGate(bash('git push --force-with-lease origin main')), null);
  assert.equal(
    runGate(bash('git push origin main && rm --force x.txt')),
    null,
    'a --force in a later command segment is not a force push',
  );
});

test('git.exe and a quoted binary path are still git', () => {
  assert.ok(isDeny(runGate(bash('git.exe reset --hard'))));
  assert.ok(
    isDeny(runGate(bash('"C:/Program Files/Git/bin/git.exe" reset --hard'))),
  );
});

test('a quoted -C path with a space does not hide the subcommand', () => {
  assert.ok(isDeny(runGate(bash('git -C "C:/My Repo" reset --hard'))));
  assert.ok(isDeny(runGate(bash('git --no-replace-objects reset --hard'))));
});

test('--hard anywhere in the reset segment and git clean --force are denied', () => {
  assert.ok(isDeny(runGate(bash('git reset HEAD~1 --hard'))));
  assert.ok(isDeny(runGate(bash('git clean --force'))));
  assert.equal(runGate(bash('git clean -n')), null);
});

test('Windows kill-by-name forms are denied', () => {
  assert.ok(isDeny(runGate(bash('taskkill.exe /F /IM node.exe'))));
  assert.ok(isDeny(runGate(bash('Get-Process node | Stop-Process'))));
  assert.ok(isDeny(runGate(bash('Stop-Process -n node'))));
  assert.ok(isDeny(runGate(bash('Stop-Process -na node'))));
  assert.equal(runGate(bash('Stop-Process -Id 1234')), null);
});

test('a bare-string tool_input is still read as the command', () => {
  assert.ok(
    isDeny(runGate({ tool_name: 'Bash', tool_input: 'git reset --hard' })),
  );
});

test('a delegation prompt that only mentions a destructive command is allowed', () => {
  for (const prompt of [
    'Audit the repo and confirm no script ever calls git reset --hard',
    'Document why we avoid pkill',
    'Never run rm -rf src',
  ]) {
    assert.equal(runGate(delegate(prompt)), null, `${prompt} must be allowed`);
  }
});

test('a delegation prompt that orders a destructive command is denied', () => {
  assert.ok(
    isDeny(runGate(delegate('Run git reset --hard to discard the changes.'))),
  );
  assert.ok(isDeny(runGate(delegate('Then rm -rf src and start over.'))));
});

test('a wrong-typed or malformed config never turns into deny-all', () => {
  const stringPatterns = {
    gates: {
      blockDestructiveShellCommands: { enabled: true, denyPatterns: 'x' },
    },
  };
  assert.ok(
    isDeny(runGate(bash('git reset --hard'), { config: stringPatterns })),
  );

  const malformedPattern = {
    gates: {
      blockDestructiveShellCommands: { enabled: true, denyPatterns: ['('] },
    },
  };
  assert.equal(runGate(bash('git status'), { config: malformedPattern }), null);

  const stringAreas = {
    gates: {
      blockDestructiveShellCommands: {
        enabled: true,
        rmRfProtectedAreas: 'src',
      },
    },
  };
  assert.ok(isDeny(runGate(bash('rm -rf src'), { config: stringAreas })));
});
