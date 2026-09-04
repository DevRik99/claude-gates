// Edge cases for brief-before-delegate: MCP tool names, alternate prompt fields, substance
// past markers, and the read-only-label exemption being voided by a mutation-risk signal.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { delegate, isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

const ENABLED = { config: { gates: { requireBriefBeforeDelegating: true } } };

const NO_BRIEF_PROMPT = 'Fix the login bug please, thanks.';

test('FIXED: a delegation tool name outside the native list is now caught via toolInGroups (MCP delegation signal)', () => {
  const payload = {
    tool_name: 'mcp__orchestrator__spawn_agent',
    tool_input: { prompt: NO_BRIEF_PROMPT },
  };
  assert.ok(isDeny(runGate(payload, ENABLED)));
});

test('FIXED: brief carried in a field other than prompt/description/task is now read via delegationPromptOf', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      instructions: NO_BRIEF_PROMPT,
      subagent_type: 'worker-senior',
    },
  };
  assert.ok(isDeny(runGate(payload, ENABLED)));
});

test('FIXED: keyword-only compliance no longer passes with content that does not carry a real brief', () => {
  const prompt = [
    'Objetivo: cosa.',
    '- paso',
    'Criterio: listo cuando funcione bien y quede resuelto satisfactoriamente para todos.',
    'Implementa el arreglo correspondiente segun corresponda en el sistema relevante.',
  ].join('\n');
  assert.ok(prompt.length >= 180, 'sanity: prompt clears the length floor');
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
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
  assert.equal(runGate(delegate(prompt), ENABLED), null);
});

test('FIXED: a mutation-risk signal in the prompt overrides a whitelisted read-only subagent name', () => {
  const prompt =
    'Implementa el guardado de datos de pago del usuario en la base y escribe el token de auth en el archivo de sesion.';
  assert.ok(isDeny(runGate(delegate(prompt, 'explore'), ENABLED)));
});

test('bilingual control: an EN mutation-risk prompt voids the exemption exactly like its ES equivalent', () => {
  const es =
    'Implementa el guardado de datos de pago del usuario en la base y escribe el token de auth en el archivo de sesion.';
  const en =
    'Implement saving the user payment data to the database and write the auth token to the session file.';
  assert.ok(isDeny(runGate(delegate(es, 'explore'), ENABLED)));
  assert.ok(isDeny(runGate(delegate(en, 'explore'), ENABLED)));
});

test('OK: a whitelisted read-only subagent name with no mutation-risk signal is still exempt', () => {
  assert.equal(runGate(delegate(NO_BRIEF_PROMPT, 'explore'), ENABLED), null);
});

test('OK: the read-only subagent exemption is case-insensitive', () => {
  assert.equal(runGate(delegate(NO_BRIEF_PROMPT, 'Explore'), ENABLED), null);
});

test('OK: a genuinely brief-less implementation delegation via Agent is denied', () => {
  assert.ok(isDeny(runGate(delegate(NO_BRIEF_PROMPT), ENABLED)));
});

test('OK: Task and invoke_subagent tool names are both covered (in TOOL_GROUPS.delegation)', () => {
  assert.ok(
    isDeny(
      runGate(
        { tool_name: 'Task', tool_input: { prompt: NO_BRIEF_PROMPT } },
        ENABLED,
      ),
    ),
  );
  assert.ok(
    isDeny(
      runGate(
        {
          tool_name: 'invoke_subagent',
          tool_input: { prompt: NO_BRIEF_PROMPT },
        },
        ENABLED,
      ),
    ),
  );
});
