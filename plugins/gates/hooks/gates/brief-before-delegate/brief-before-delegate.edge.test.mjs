// Edge-case audit for brief-before-delegate. See gate comment header for the rule this
// gate enforces. Each test below demonstrates either a confirmed BUG (asserted with a
// comment explaining why the result is wrong) or an OK (confirms the gate handles the
// case correctly). Run: node --test brief-before-delegate.edge.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'brief-before-delegate-edge-'));
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

const ENABLED = { config: { gates: { requireBriefBeforeDelegating: true } } };

const NO_BRIEF_PROMPT = 'Fix the login bug please, thanks.';

test('FIXED: a delegation tool name outside the native list is now caught via toolInGroups (MCP delegation signal)', () => {
  // toolInGroups matches an MCP tool name whose action segment carries a delegation
  // signal (agent/task/delegat/spawn/dispatch/orchestrat/worker), so a renamed
  // orchestration tool like mcp__orchestrator__spawn_agent is no longer invisible.
  const payload = {
    tool_name: 'mcp__orchestrator__spawn_agent',
    tool_input: { prompt: NO_BRIEF_PROMPT },
  };
  const result = runGate(payload, ENABLED);
  assert.ok(isDeny(result), 'gate now denies the brief-less prompt under the MCP tool name too');
});

test('FIXED: brief carried in a field other than prompt/description/task is now read via delegationPromptOf', () => {
  // delegationPromptOf also reads instructions/message/input/Prompt, so a payload that
  // carries the delegation text under "instructions" (as some MCP subagent tools do) is
  // no longer read as an empty prompt.
  const payload = {
    tool_name: 'Agent',
    tool_input: { instructions: NO_BRIEF_PROMPT, subagent_type: 'worker-senior' },
  };
  const result = runGate(payload, ENABLED);
  assert.ok(isDeny(result), 'gate now sees the brief under "instructions" and denies it for being brief-less');
});

test('FIXED: keyword-only compliance no longer passes with content that does not carry a real brief', () => {
  // missingSignals now requires each marker to be followed by substantive content
  // (markerHasSubstance / stepsHaveSubstance), not just the marker's presence. A prompt
  // that pastes GOAL/STEPS/CRITERION markers next to filler no longer clears the check.
  const prompt = [
    'Objetivo: cosa.',
    '- paso',
    'Criterio: listo cuando funcione bien y quede resuelto satisfactoriamente para todos.',
    'Implementa el arreglo correspondiente segun corresponda en el sistema relevante.',
  ].join('\n');
  assert.ok(prompt.length >= 180, 'sanity: prompt clears the length floor');
  const result = runGate({ tool_name: 'Agent', tool_input: { prompt } }, ENABLED);
  assert.ok(
    isDeny(result),
    'gate now denies a brief that is letter-compliant (has GOAL/STEPS/CRITERION markers) but has no real content',
  );
});

test('FIXED: a real brief with substantial content past each marker is still allowed', () => {
  const prompt = [
    'Objetivo: fix the broken login redirect so users land on the correct dashboard page.',
    '',
    'Haceres:',
    '- update src/auth/redirect.js to use the post-login route',
    '- add a regression test for the redirect',
    '',
    'Criterio: se considera hecho cuando el test de regresion pasa y el login redirige correctamente.',
  ].join('\n');
  assert.equal(runGate({ tool_name: 'Agent', tool_input: { prompt } }, ENABLED), null);
});

test('FIXED: a mutation-risk signal in the prompt overrides a whitelisted read-only subagent name', () => {
  // isReadOnlySubagent now voids the name-based exemption whenever the prompt itself
  // carries a mutation-risk signal (money/auth/data/write/deploy): a subagent named
  // "explore" cannot exempt a real payment-data mutation just by using that label.
  const prompt =
    'Implementa el guardado de datos de pago del usuario en la base y escribe el token de auth en el archivo de sesion.';
  const result = runGate(
    { tool_name: 'Agent', tool_input: { prompt, subagent_type: 'explore' } },
    ENABLED,
  );
  assert.ok(
    isDeny(result),
    'gate no longer exempts a mutation-risk prompt solely because subagent_type says "explore"',
  );
});

test('bilingual control: an EN mutation-risk prompt voids the exemption exactly like its ES equivalent', () => {
  const es =
    'Implementa el guardado de datos de pago del usuario en la base y escribe el token de auth en el archivo de sesion.';
  const en =
    'Implement saving the user payment data to the database and write the auth token to the session file.';
  const resultEs = runGate(
    { tool_name: 'Agent', tool_input: { prompt: es, subagent_type: 'explore' } },
    ENABLED,
  );
  const resultEn = runGate(
    { tool_name: 'Agent', tool_input: { prompt: en, subagent_type: 'explore' } },
    ENABLED,
  );
  assert.ok(isDeny(resultEs));
  assert.ok(isDeny(resultEn));
});

test('OK: a whitelisted read-only subagent name with no mutation-risk signal is still exempt', () => {
  assert.equal(
    runGate(
      { tool_name: 'Agent', tool_input: { prompt: NO_BRIEF_PROMPT, subagent_type: 'explore' } },
      ENABLED,
    ),
    null,
  );
});

test('OK: a genuinely brief-less implementation delegation via Agent is denied', () => {
  const result = runGate({ tool_name: 'Agent', tool_input: { prompt: NO_BRIEF_PROMPT } }, ENABLED);
  assert.ok(isDeny(result));
});

test('OK: Task and invoke_subagent tool names are both covered (in TOOL_GROUPS.delegation)', () => {
  assert.ok(
    isDeny(runGate({ tool_name: 'Task', tool_input: { prompt: NO_BRIEF_PROMPT } }, ENABLED)),
  );
  assert.ok(
    isDeny(
      runGate({ tool_name: 'invoke_subagent', tool_input: { prompt: NO_BRIEF_PROMPT } }, ENABLED),
    ),
  );
});
