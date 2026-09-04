import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ask, isDeny, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { autonomous } = {}) {
  return runGateProcess(GATE, payload, {
    config: { gates: { autonomousMode: { enabled: Boolean(autonomous) } } },
  });
}

test('autonomous mode ON: AskUserQuestion is denied', () => {
  assert.ok(isDeny(runGate(ask('A or B?'), { autonomous: true })));
});

test('autonomous mode OFF (default): questions pass', () => {
  assert.equal(runGate(ask('A or B?'), { autonomous: false }), null);
});

test('even ON, a non-question tool is never blocked', () => {
  assert.equal(runGate(write('x.js', ''), { autonomous: true }), null);
});
