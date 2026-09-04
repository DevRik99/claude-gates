import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  isDeny,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

test('denies writing to .env and a mutating shell command targeting it', () => {
  assert.ok(isDeny(runGate(write('/repo/.env'))));
  assert.ok(isDeny(runGate(bash('rm .env'))));
  assert.ok(isDeny(runGate(bash('touch package-lock.json'))));
});

test('allows an innocuous write and a read-only command mentioning a protected path', () => {
  assert.equal(runGate(write('/repo/src/index.js')), null);
  assert.equal(runGate(bash('echo "reading .env for debugging"')), null);
  assert.equal(runGate(bash('cat .env')), null);
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(write('/repo/.env'), {
      config: { gates: { blockWritesToProtectedPaths: false } },
    }),
    null,
  );
});

test('project protectedPaths replaces the built-in list', () => {
  const config = {
    gates: {
      blockWritesToProtectedPaths: {
        enabled: true,
        protectedPaths: ['secrets.yaml'],
      },
    },
  };
  assert.equal(runGate(write('/repo/.env'), { config }), null);
  assert.ok(isDeny(runGate(write('/repo/secrets.yaml'), { config })));
});

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('a directory fragment matches only its own segment sequence: src/hooks/ is not the harness', () => {
  assert.equal(runGate(write('/repo/src/hooks/useAuth.ts')), null);
  assert.equal(runGate(bash('mv src/hooks/a.ts b.ts')), null);
  assert.ok(isDeny(runGate(write('/repo/.claude/hooks/x.mjs'))));
  assert.ok(isDeny(runGate(bash('rm .claude/hooks/gates/x.mjs'))));
});

test('a file fragment matches the basename exactly: .env is not .env.example', () => {
  assert.equal(runGate(write('/repo/.env.example')), null);
  assert.equal(runGate(write('/repo/config.environment.ts')), null);
  assert.ok(isDeny(runGate(write('/repo/.env.local'))));
  assert.ok(isDeny(runGate(write('/repo/.env.production'))));
});

test('paths are normalized before matching (.. collapsed, backslashes)', () => {
  assert.equal(runGate(write('/repo/hooks/../src/x.ts')), null);
  assert.ok(isDeny(runGate(write('/repo/src/../.env'))));
  assert.ok(isDeny(runGate(write('repo\\.claude\\hooks\\x.mjs'))));
});

test('a mutating command in one segment does not taint a read in another', () => {
  assert.equal(runGate(bash('npm install; cat .env')), null);
  assert.equal(runGate(bash('npm install && cat .env')), null);
});

test('every mutating form that names a protected path is denied', () => {
  for (const command of [
    "sed --in-place 's/a/b/' .env",
    'git checkout -- .env',
    'git restore .env',
    'unlink .env',
    'dd if=/dev/zero of=.env',
    "perl -pi -e 's/a/b/' .env",
    'Set-Content .env "x"',
    'Set-Content -Path .env -Value x',
    'Remove-Item .env',
    'del .env',
    'erase .env',
    'Out-File -FilePath .env',
    'New-Item .env',
    'Copy-Item a .env',
    'Move-Item a .env',
    'Rename-Item .env old',
    'copy a .env',
    'move a .env',
    'ren .env old',
    'echo x > .env',
    'sudo rm .env',
  ]) {
    assert.ok(isDeny(runGate(bash(command))), `${command} must be denied`);
  }
});

test('mutatingCommands [] turns the argument rule off but redirections stay covered', () => {
  const config = {
    gates: {
      blockWritesToProtectedPaths: { enabled: true, mutatingCommands: [] },
    },
  };
  assert.equal(runGate(bash('cat .env'), { config }), null);
  assert.equal(runGate(bash('rm .env'), { config }), null);
  assert.ok(isDeny(runGate(bash('echo x > .env'), { config })));
});

test('a malformed mutatingCommands entry is skipped, never a deny-all', () => {
  const config = {
    gates: {
      blockWritesToProtectedPaths: { enabled: true, mutatingCommands: ['('] },
    },
  };
  assert.equal(runGate(bash('cat .env'), { config }), null);
});

test('the deny names the target and the fragment it matched', () => {
  const result = runGate(bash('rm .env'));
  assert.match(messageOf(result), /'\.env'/);
  assert.match(messageOf(result), /protectedPaths/);
});
