// Edge-case audit for risk-level. Each test demonstrates a confirmed BUG or an OK.
// Run: node --test risk-level.edge.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'risk-level-edge-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLED = { config: { gates: { requireDeclaredRiskLevel: true } } };

const SENSITIVE_NO_LEVEL =
  'Implementa el cobro del pago con la nueva pasarela de dinero para el checkout.';

test('FIXED: a delegation tool name outside the native list is now caught via toolInGroups (MCP delegation signal)', () => {
  const result = runGate(
    { tool_name: 'mcp__orchestrator__spawn_agent', tool_input: { prompt: SENSITIVE_NO_LEVEL } },
    ENABLED,
  );
  assert.ok(isDeny(result), 'gate now denies the no-level prompt under the MCP tool name too');
});

test('FIXED: prompt carried in a field other than prompt/description/task is now read via delegationPromptOf', () => {
  const result = runGate(
    { tool_name: 'Agent', tool_input: { instructions: SENSITIVE_NO_LEVEL } },
    ENABLED,
  );
  assert.ok(isDeny(result), 'gate now sees the prompt under "instructions" and denies it for missing LEVEL');
});

test('FIXED: a mutation-risk signal in the prompt overrides a whitelisted read-only subagent name', () => {
  const result = runGate(
    { tool_name: 'Agent', tool_input: { prompt: SENSITIVE_NO_LEVEL, subagent_type: 'plan' } },
    ENABLED,
  );
  assert.ok(
    isDeny(result),
    'gate no longer exempts a real money-mutation delegation solely because subagent_type says "plan"',
  );
});

test('FIXED: the LAST level declaration governs, not the first (a decoy early mention no longer wins)', () => {
  // Previously DECLARED_LEVEL_PATTERN.exec(prompt) (no /g) took only the first match, so
  // a decoy HIGH-RISK mention near the top let a real MICRO-declared money mutation
  // through. operativeLevel() now takes the LAST declaration as operative: MICRO governs
  // here and the real money-mutation signal contradicts it, so the gate denies.
  const prompt =
    'NIVEL: HIGH-RISK (nota: eso era para la tarea anterior, ignorar). Para esta tarea: NIVEL: MICRO. ' +
    'Implementa el cobro del pago con la nueva pasarela de dinero para el checkout.';
  const result = runGate({ tool_name: 'Agent', tool_input: { prompt } }, ENABLED);
  assert.ok(
    isDeny(result),
    'gate now denies: the operative (last) declaration is MICRO, which contradicts the real money-mutation signal',
  );
});

test('FIXED: two DIFFERENT levels that both look operative are denied as ambiguous, not silently resolved', () => {
  const prompt =
    'NIVEL: MICRO. Mas adelante, NIVEL: HIGH-RISK. Arregla el boton que no cambia de color en la pagina.';
  const result = runGate({ tool_name: 'Agent', tool_input: { prompt } }, ENABLED);
  assert.ok(
    isDeny(result),
    'gate denies and asks for a single unambiguous LEVEL when multiple different levels are declared',
  );
});

test('OK: repeating the SAME level twice is not treated as ambiguous', () => {
  const result = runGate(
    {
      tool_name: 'Agent',
      tool_input: {
        prompt:
          'NIVEL: STANDARD. Como se declaro, NIVEL: STANDARD. Arregla el boton que no cambia de color.',
      },
    },
    ENABLED,
  );
  assert.equal(result, null);
});

test('OK: same sensitive prompt without a read-only subagent name and no level is denied', () => {
  const result = runGate({ tool_name: 'Agent', tool_input: { prompt: SENSITIVE_NO_LEVEL } }, ENABLED);
  assert.ok(isDeny(result));
});

test('OK: Task and invoke_subagent tool names are both covered', () => {
  assert.ok(isDeny(runGate({ tool_name: 'Task', tool_input: { prompt: SENSITIVE_NO_LEVEL } }, ENABLED)));
  assert.ok(
    isDeny(
      runGate({ tool_name: 'invoke_subagent', tool_input: { prompt: SENSITIVE_NO_LEVEL } }, ENABLED),
    ),
  );
});
