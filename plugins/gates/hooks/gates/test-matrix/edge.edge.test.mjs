// Edge case for test-matrix: a Task delegation carrying its brief in `description` is read
// through delegationPromptOf and checked like a `prompt`.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const ENABLED = {
  config: { gates: { requireTestMatrixWhenImplementing: true } },
};
const MONEY = 'Nivel: STANDARD\nImplementá el cobro de la cuota.';

test('FIXED: a Task delegation carrying its brief in `description` is now checked', () => {
  const payload = {
    tool_name: 'Task',
    tool_input: { description: MONEY, subagent_type: 'backend' },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, ENABLED)));
});

test('OK: the equivalent payload using `prompt` IS caught (control)', () => {
  const payload = {
    tool_name: 'Task',
    tool_input: { prompt: MONEY, subagent_type: 'backend' },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, ENABLED)));
});
