// Edge cases for no-memory-dependency. The gate DENIES (its configKey keeps the historical
// warn* name); a bypass here means a real memory dependency slipping through, not something
// unsafe being blocked.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { delegate, isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

const ENABLED = { config: { gates: { warnMemoryDependencyInBrief: true } } };
const MEMORY_PROMPT = 'Como hablamos antes, aplica el mismo criterio.';

test('FIXED: a delegation tool name outside the native list is now caught via toolInGroups (MCP delegation signal)', () => {
  const result = runGate(
    {
      tool_name: 'mcp__orchestrator__spawn_agent',
      tool_input: { prompt: MEMORY_PROMPT },
    },
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('FIXED: prompt carried in a field other than prompt/description/task is now read via delegationPromptOf', () => {
  const result = runGate(
    { tool_name: 'Agent', tool_input: { instructions: MEMORY_PROMPT } },
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('FIXED: a persistence noun with no verb no longer suppresses the deny', () => {
  const prompt =
    'Como dijimos del login (el reporte esta en incident.md), aplica el mismo criterio de siempre.';
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
});

test('OK: a genuine memory-dependency phrase via Agent is denied', () => {
  assert.ok(isDeny(runGate(delegate(MEMORY_PROMPT), ENABLED)));
});

test('OK: a memory phrase paired with a real persistence verb still suppresses the deny', () => {
  assert.equal(
    runGate(
      delegate(
        'Como quedamos, guarda la decision en .ai/decision.md antes de continuar.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('OK: a memory phrase inside a double-quoted string is not the prompt intent', () => {
  assert.equal(
    runGate(
      delegate(
        'Rename the label "as we discussed" to "as agreed" in the settings page copy.',
      ),
      ENABLED,
    ),
    null,
  );
});
