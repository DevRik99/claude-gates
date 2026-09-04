// Edge case for implementation-pipeline: a Task delegation carrying its brief in
// `description` is read through delegationPromptOf and checked like a `prompt`.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const ENABLED = { config: { gates: { requireImplementationPipeline: true } } };
const NO_STAGES = 'Nivel: STANDARD\nImplementá el checkout.';

test('FIXED: a Task delegation carrying its brief in `description` is now checked', () => {
  const payload = {
    tool_name: 'Task',
    tool_input: { description: NO_STAGES, subagent_type: 'backend' },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, ENABLED)));
});

test('OK: the equivalent payload using `prompt` IS caught (control)', () => {
  const payload = {
    tool_name: 'Task',
    tool_input: { prompt: NO_STAGES, subagent_type: 'backend' },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, ENABLED)));
});
