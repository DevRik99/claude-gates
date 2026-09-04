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

const ENABLED = { gates: { blockWaitingCommands: true } };

function runGate(payload, options = { config: ENABLED }) {
  return runGateProcess(GATE, payload, options);
}

test('denies sleep in foreground, a dev server, and a polling loop', () => {
  assert.ok(isDeny(runGate(bash('sleep 30'))));
  assert.ok(isDeny(runGate(bash('npm run dev'))));
  assert.ok(
    isDeny(runGate(bash('until curl -sf localhost:3000; do sleep 2; done'))),
  );
});

test('allows an innocuous command and a backgrounded long-runner', () => {
  assert.equal(runGate(bash('git status')), null);
  assert.equal(runGate(bash('npm run dev', { run_in_background: true })), null);
  assert.equal(runGate(bash('sleep 30 &')), null);
});

test('disabled by default: the gate does not run without opting in', () => {
  assert.equal(runGate(bash('sleep 30'), {}), null);
});

test('a delegation prompt telling the subagent to sleep-wait is denied', () => {
  assert.ok(
    isDeny(
      runGate(
        delegate('Please then sleep 60 seconds until the server is ready.'),
      ),
    ),
  );
});

test('the wait-justified marker with a reason escapes the block', () => {
  assert.equal(
    runGate(
      bash('sleep 30 # WAIT-JUSTIFIED: waiting for migration lock release'),
    ),
    null,
  );
});

test('project blockingPatterns replaces the built-in list', () => {
  const config = {
    gates: {
      blockWaitingCommands: {
        enabled: true,
        blockingPatterns: [String.raw`\bcustom-block\b`],
      },
    },
  };
  assert.equal(runGate(bash('sleep 30'), { config }), null);
  assert.ok(isDeny(runGate(bash('custom-block now'), { config })));
});

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('leading whitespace, a subshell, bash -c and a variable count still sleep', () => {
  for (const command of [
    ' sleep 30',
    'bash -c "sleep 5"',
    '(sleep 30)',
    'sleep $N',
  ]) {
    assert.ok(isDeny(runGate(bash(command))), `${command} must be denied`);
  }
});

test('a multi-line polling loop is caught', () => {
  assert.ok(
    isDeny(runGate(bash('while true\ndo\n  sleep $I\ndone'))),
    'the loop body sleeps',
  );
});

test('long-form and compose log following are caught', () => {
  assert.ok(isDeny(runGate(bash('tail --follow app.log'))));
  assert.ok(isDeny(runGate(bash('docker compose logs -f'))));
  assert.ok(isDeny(runGate(bash('docker-compose logs -f web'))));
});

test('Windows waits are caught: Start-Process -Wait, ping -n, timeout /t, pause, Read-Host', () => {
  for (const command of [
    'Start-Process node -ArgumentList app.js -Wait',
    'ping -n 30 127.0.0.1',
    'timeout /t 5',
    'pause',
    'Read-Host "Press enter"',
  ]) {
    assert.ok(isDeny(runGate(bash(command))), `${command} must be denied`);
  }
});

test('a detach form exempts only its own segment', () => {
  assert.ok(isDeny(runGate(bash('Start-Job {x}; Wait-Job'))));
  assert.ok(isDeny(runGate(bash('npm run dev & sleep 5'))));
  assert.equal(runGate(bash('docker compose up -d')), null);
  assert.equal(runGate(bash('nohup npm run dev > out.log 2>&1 &')), null);
});

test('the words run_in_background in the command exempt nothing; only the real flag does', () => {
  assert.ok(isDeny(runGate(bash('sleep 30 && echo run_in_background'))));
  assert.ok(
    isDeny(runGate(bash('sleep 30', { run_in_background: 'true' }))),
    'a string "true" is not the flag',
  );
});

test('a bounded timeout wrapper and non-dev script names are allowed', () => {
  assert.equal(runGate(bash('timeout 120 npm test')), null);
  assert.equal(runGate(bash('npm run start:prod')), null);
  assert.equal(runGate(bash('npm run watch-tests')), null);
  assert.ok(isDeny(runGate(bash('timeout 30'))), 'a bare timeout is a sleep');
});

test('a delegation prompt that forbids the blocking command is allowed', () => {
  assert.equal(
    runGate(delegate('Do not run npm run dev; it is already running.')),
    null,
  );
});

test('the deny names what matched and the escape hatch', () => {
  const result = runGate(bash('sleep 30'));
  assert.match(messageOf(result), /matched: "sleep"/);
  assert.match(messageOf(result), /WAIT-JUSTIFIED:/);
});
