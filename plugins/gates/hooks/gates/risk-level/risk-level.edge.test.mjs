// Edge cases for risk-level: MCP tool names, alternate prompt fields, the read-only label
// voided by a mutation-risk signal, and which LEVEL declaration governs.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  delegate,
  isDeny,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

const ENABLED = { config: { gates: { requireDeclaredRiskLevel: true } } };

const SENSITIVE_NO_LEVEL =
  'Implementa el cobro del pago con la nueva pasarela de dinero para el checkout.';

test('FIXED: a delegation tool name outside the native list is now caught via toolInGroups (MCP delegation signal)', () => {
  const result = runGate(
    {
      tool_name: 'mcp__orchestrator__spawn_agent',
      tool_input: { prompt: SENSITIVE_NO_LEVEL },
    },
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('FIXED: prompt carried in a field other than prompt/description/task is now read via delegationPromptOf', () => {
  const result = runGate(
    { tool_name: 'Agent', tool_input: { instructions: SENSITIVE_NO_LEVEL } },
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('FIXED: a mutation-risk signal in the prompt overrides a whitelisted read-only subagent name', () => {
  assert.ok(isDeny(runGate(delegate(SENSITIVE_NO_LEVEL, 'Plan'), ENABLED)));
});

test('FIXED: a decoy early declaration does not exempt: contradictory levels are denied as ambiguous', () => {
  const prompt = [
    'NIVEL: HIGH-RISK (nota: eso era para la tarea anterior, ignorar). Para esta tarea: NIVEL: MICRO.',
    SENSITIVE_NO_LEVEL,
  ].join(' ');
  const result = runGate(delegate(prompt), ENABLED);
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /single, unambiguous LEVEL/);
});

test('FIXED: a decoy MICRO before the real HIGH-RISK is ambiguous, never an exemption', () => {
  const prompt = [
    'LEVEL: MICRO (previous task). LEVEL: HIGH-RISK.',
    SENSITIVE_NO_LEVEL,
  ].join(' ');
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
});

test('FIXED: two DIFFERENT levels that both look operative are denied as ambiguous, not silently resolved', () => {
  const prompt =
    'NIVEL: MICRO. Mas adelante, NIVEL: HIGH-RISK. Arregla el boton que no cambia de color en la pagina.';
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
});

test('OK: repeating the SAME level twice is not treated as ambiguous', () => {
  assert.equal(
    runGate(
      delegate(
        'NIVEL: STANDARD. Como se declaro, NIVEL: STANDARD. Arregla el boton que no cambia de color.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('OK: same sensitive prompt without a read-only subagent name and no level is denied', () => {
  assert.ok(isDeny(runGate(delegate(SENSITIVE_NO_LEVEL), ENABLED)));
});

test('OK: Task and invoke_subagent tool names are both covered', () => {
  assert.ok(
    isDeny(
      runGate(
        { tool_name: 'Task', tool_input: { prompt: SENSITIVE_NO_LEVEL } },
        ENABLED,
      ),
    ),
  );
  assert.ok(
    isDeny(
      runGate(
        {
          tool_name: 'invoke_subagent',
          tool_input: { prompt: SENSITIVE_NO_LEVEL },
        },
        ENABLED,
      ),
    ),
  );
});
