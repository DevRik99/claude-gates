// Edge-case audit for intent-flow. Each test demonstrates a confirmed BUG or an OK.
// Run: node --test intent-flow.edge.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'intent-flow-edge-'));
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

const ENABLED = { config: { gates: { requireScopeListBeforeDelegating: true } } };

const SENSITIVE_NO_SCOPE =
  'Implementa el cobro del pago con la nueva pasarela de dinero para el checkout.';

test('FIXED: a delegation tool name outside the native list is now caught via toolInGroups (MCP delegation signal)', () => {
  const result = runGate(
    { tool_name: 'mcp__orchestrator__spawn_agent', tool_input: { prompt: SENSITIVE_NO_SCOPE } },
    ENABLED,
  );
  assert.ok(isDeny(result), 'gate now denies the sensitive-no-scope prompt under the MCP tool name too');
});

test('FIXED: prompt carried in a field other than prompt/description/task is now read via delegationPromptOf', () => {
  const result = runGate(
    { tool_name: 'Agent', tool_input: { instructions: SENSITIVE_NO_SCOPE } },
    ENABLED,
  );
  assert.ok(isDeny(result), 'gate now sees the prompt under "instructions" and denies it for missing scope list');
});

test('FIXED: a mutation-risk signal in the prompt overrides a whitelisted read-only subagent name', () => {
  // isReadOnlySubagent now voids the name-based exemption whenever the prompt itself
  // carries a mutation-risk signal (money/auth/data/write/deploy): a subagent named
  // "explore" cannot exempt a real money-mutation delegation just by using that label.
  const result = runGate(
    { tool_name: 'Agent', tool_input: { prompt: SENSITIVE_NO_SCOPE, subagent_type: 'explore' } },
    ENABLED,
  );
  assert.ok(
    isDeny(result),
    'gate no longer exempts a real money-mutation delegation solely because subagent_type says "explore"',
  );
});

test('OK: a whitelisted read-only subagent name with no mutation-risk signal is still exempt', () => {
  assert.equal(
    runGate(
      {
        tool_name: 'Agent',
        tool_input: {
          prompt: 'Arregla el boton que no cambia de color al pasar el mouse.',
          subagent_type: 'explore',
        },
      },
      ENABLED,
    ),
    null,
  );
});

test('OK: same sensitive prompt without a read-only subagent name is denied', () => {
  const result = runGate({ tool_name: 'Agent', tool_input: { prompt: SENSITIVE_NO_SCOPE } }, ENABLED);
  assert.ok(isDeny(result));
});

test('OK: Task and invoke_subagent tool names are both covered', () => {
  assert.ok(isDeny(runGate({ tool_name: 'Task', tool_input: { prompt: SENSITIVE_NO_SCOPE } }, ENABLED)));
  assert.ok(
    isDeny(
      runGate({ tool_name: 'invoke_subagent', tool_input: { prompt: SENSITIVE_NO_SCOPE } }, ENABLED),
    ),
  );
});
