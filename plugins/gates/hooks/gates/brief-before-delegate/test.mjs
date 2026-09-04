import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  delegate,
  isDeny,
  isWarn,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

const ENABLED = { config: { gates: { requireBriefBeforeDelegating: true } } };

test('denies an implementation delegation with no goal/steps/criterion', () => {
  const result = runGate(
    delegate('Fix the login bug please, thanks.'),
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('allows a complete brief with goal, steps and done-when criterion', () => {
  const prompt = [
    'Objetivo: fix the broken login redirect so users land on the dashboard.',
    '',
    'Haceres:',
    '- update src/auth/redirect.js to use the post-login route',
    '- add a regression test for the redirect',
    '',
    'Criterio: se considera hecho cuando el test de regresion pasa y el login redirige correctamente.',
  ].join('\n');
  assert.equal(runGate(delegate(prompt), ENABLED), null);
});

test('allows a read-only exploration prompt without a brief', () => {
  assert.equal(
    runGate(
      delegate('Investiga donde esta definida la funcion de login.'),
      ENABLED,
    ),
    null,
  );
});

test('allows a read-only subagent even with an implementation verb', () => {
  assert.equal(
    runGate(
      delegate('Implementa un resumen de como arreglar el login.', 'explore'),
      ENABLED,
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(delegate('Fix the login bug please, thanks.'), {
      config: { gates: { requireBriefBeforeDelegating: false } },
    }),
    null,
  );
});

test('off by default when config is silent', () => {
  assert.equal(runGate(delegate('Fix the login bug please, thanks.')), null);
});

test('project minBriefLength override changes the length threshold', () => {
  const config = {
    gates: {
      requireBriefBeforeDelegating: { enabled: true, minBriefLength: 20 },
    },
  };
  const prompt =
    'Fix the login bug in the auth module now, using the same approach as before.';
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
  // With the floor lowered the prompt clears the length check; a present goal leaves only
  // two signals missing, which warns instead of denying — proving the override applied.
  const withGoal = `Goal: ${prompt}`;
  const result = runGate(delegate(withGoal), { config });
  assert.ok(!isDeny(result));
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('a rename request is an implementation request and is checked for a brief', () => {
  const result = runGate(
    delegate('Goal: rename foo to bar across the module, please.'),
    ENABLED,
  );
  assert.ok(isDeny(result), 'rename was missing from the verb list before');
});

test('a README/documentation update is not an implementation brief and is allowed', () => {
  assert.equal(
    runGate(
      delegate(
        'Update the README to document the new gates and how each one is enabled.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('a non-array readOnlySubagents param falls back to the default instead of denying everything', () => {
  const config = {
    gates: {
      requireBriefBeforeDelegating: {
        enabled: true,
        readOnlySubagents: 'explore',
      },
    },
  };
  const result = runGate(
    delegate('Investiga donde esta definida la funcion de login.', 'explore'),
    { config },
  );
  assert.ok(!isDeny(result));
});

test('a marker whose first occurrence is empty still counts when a later occurrence has substance', () => {
  const prompt = [
    'Goal:',
    'Goal: fix the broken login redirect so users land on the dashboard after signing in.',
    '',
    '- update src/auth/redirect.js to use the post-login route',
    '- add a regression test for the redirect',
    '',
    'Criterio:',
    'Criterio: se considera hecho cuando el test de regresion pasa y el login redirige correctamente.',
  ].join('\n');
  assert.equal(runGate(delegate(prompt), ENABLED), null);
});

test('a string tool_input is not a delegation prompt and is allowed', () => {
  assert.equal(
    runGate({ tool_name: 'Agent', tool_input: 'Fix the login bug' }, ENABLED),
    null,
  );
});

test('a non-numeric minBriefLength falls back to the default floor', () => {
  const config = {
    gates: {
      requireBriefBeforeDelegating: { enabled: true, minBriefLength: 'lots' },
    },
  };
  const result = runGate(delegate('Fix the login bug please, thanks.'), {
    config,
  });
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /too short/);
});

test('a partial brief warns instead of denying', () => {
  const prompt = [
    'Goal: fix the broken login redirect so users land on the dashboard after signing in.',
    '',
    '- update src/auth/redirect.js to use the post-login route',
    '- add a regression test for the redirect and run the whole auth suite locally.',
  ].join('\n');
  const result = runGate(delegate(prompt), ENABLED);
  assert.ok(isWarn(result));
  assert.match(messageOf(result), /DONE-WHEN/);
});
