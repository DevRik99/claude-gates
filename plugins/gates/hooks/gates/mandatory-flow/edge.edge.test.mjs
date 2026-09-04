// Edge cases for mandatory-flow: a brief carried in `description`, and a path-traversal
// slug in the pointer file (rejected as if empty).
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, makeProject, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const ENABLED = { gates: { requireLiveTaskWhenImplementing: true } };
const IMPLEMENT = 'Nivel: STANDARD\nImplementá el checkout.';

test('FIXED: a Task delegation carrying its brief in `description` is now checked', () => {
  const project = makeProject({ config: ENABLED });
  const payload = {
    tool_name: 'Task',
    tool_input: { description: IMPLEMENT, subagent_type: 'backend' },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, { project })));
});

test('OK: the equivalent payload using `prompt` with no ACTIVA pointer IS denied (control)', () => {
  const project = makeProject({ config: ENABLED });
  const payload = {
    tool_name: 'Task',
    tool_input: { prompt: IMPLEMENT, subagent_type: 'backend' },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, { project })));
});

test('FIXED: a path-traversal slug in ACTIVA no longer lets an unrelated file satisfy hasTaskContract', () => {
  const project = makeProject({
    config: ENABLED,
    files: {
      [join('evil', 'asserts.md')]: 'unrelated content',
      [join('.ai', 'pipeline', 'ACTIVA')]: '../../evil',
    },
  });
  const payload = {
    tool_name: 'Agent',
    tool_input: { prompt: IMPLEMENT, subagent_type: 'backend' },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, { project })));
});
