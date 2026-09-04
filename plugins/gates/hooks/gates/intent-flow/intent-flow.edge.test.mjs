// Edge cases for intent-flow: MCP tool names, alternate prompt fields, and the read-only
// label being voided by a mutation-risk signal.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { delegate, isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

const ENABLED = {
  config: { gates: { requireScopeListBeforeDelegating: true } },
};

const SENSITIVE_NO_SCOPE =
  'Implementa el cobro del pago con la nueva pasarela de dinero para el checkout.';

test('FIXED: a delegation tool name outside the native list is now caught via toolInGroups (MCP delegation signal)', () => {
  const result = runGate(
    {
      tool_name: 'mcp__orchestrator__spawn_agent',
      tool_input: { prompt: SENSITIVE_NO_SCOPE },
    },
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('FIXED: prompt carried in a field other than prompt/description/task is now read via delegationPromptOf', () => {
  const result = runGate(
    { tool_name: 'Agent', tool_input: { instructions: SENSITIVE_NO_SCOPE } },
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('FIXED: a mutation-risk signal in the prompt overrides a whitelisted read-only subagent name', () => {
  assert.ok(isDeny(runGate(delegate(SENSITIVE_NO_SCOPE, 'explore'), ENABLED)));
});

test('OK: a whitelisted read-only subagent name with no mutation-risk signal is still exempt', () => {
  assert.equal(
    runGate(
      delegate(
        'Arregla el boton que no cambia de color al pasar el mouse.',
        'Explore',
      ),
      ENABLED,
    ),
    null,
  );
});

test('OK: same sensitive prompt without a read-only subagent name is denied', () => {
  assert.ok(isDeny(runGate(delegate(SENSITIVE_NO_SCOPE), ENABLED)));
});

test('OK: Task and invoke_subagent tool names are both covered', () => {
  assert.ok(
    isDeny(
      runGate(
        { tool_name: 'Task', tool_input: { prompt: SENSITIVE_NO_SCOPE } },
        ENABLED,
      ),
    ),
  );
  assert.ok(
    isDeny(
      runGate(
        {
          tool_name: 'invoke_subagent',
          tool_input: { prompt: SENSITIVE_NO_SCOPE },
        },
        ENABLED,
      ),
    ),
  );
});
