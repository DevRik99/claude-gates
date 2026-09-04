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

function enabledWith(parameters) {
  return {
    config: {
      gates: { requireDeclaredRiskLevel: { enabled: true, ...parameters } },
    },
  };
}

const LOW_RISK_PROMPT = 'Arregla el boton que no cambia de color en la pagina.';
const MONEY_PROMPT =
  'Implementa el cobro del pago con la nueva pasarela de dinero.';
const LEVEL_MICRO_ES = 'NIVEL: MICRO';
const LEVEL_STANDARD_ES = 'NIVEL: STANDARD';

function withLevel(declaration, prompt) {
  return [declaration, prompt].join('\n\n');
}

test('denies an implementation delegation with no declared level', () => {
  assert.ok(isDeny(runGate(delegate(LOW_RISK_PROMPT), ENABLED)));
});

test('allows a declared level consistent with a low-risk request', () => {
  assert.equal(
    runGate(delegate(withLevel(LEVEL_STANDARD_ES, LOW_RISK_PROMPT)), ENABLED),
    null,
  );
});

test('denies a declared level that contradicts a real high-impact signal', () => {
  assert.ok(
    isDeny(runGate(delegate(withLevel(LEVEL_MICRO_ES, MONEY_PROMPT)), ENABLED)),
  );
});

test('allows HIGH-RISK declared for a high-impact request', () => {
  assert.equal(
    runGate(delegate(withLevel('NIVEL: HIGH-RISK', MONEY_PROMPT)), ENABLED),
    null,
  );
});

test('bilingual control: an EN money-mutation brief contradicts a low level exactly like its ES equivalent', () => {
  const en = delegate(
    withLevel(
      'LEVEL: MICRO',
      'Implement the payment charge with the new money gateway.',
    ),
  );
  assert.ok(
    isDeny(runGate(delegate(withLevel(LEVEL_MICRO_ES, MONEY_PROMPT)), ENABLED)),
  );
  assert.ok(isDeny(runGate(en, ENABLED)));
});

test('allows a read-only subagent without a declared level when the prompt carries no mutation-risk signal', () => {
  assert.equal(
    runGate(
      delegate('Explica como funciona el flujo de checkout actual.', 'explore'),
      ENABLED,
    ),
    null,
  );
});

test('a read-only subagent name no longer exempts a real money-mutation prompt from declaring a level', () => {
  assert.ok(isDeny(runGate(delegate(MONEY_PROMPT, 'explore'), ENABLED)));
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(delegate(LOW_RISK_PROMPT), {
      config: { gates: { requireDeclaredRiskLevel: false } },
    }),
    null,
  );
});

test('project highImpactPatterns override narrows what forces HIGH-RISK', () => {
  const prompt = withLevel(LEVEL_MICRO_ES, MONEY_PROMPT);
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
  assert.equal(
    runGate(
      delegate(prompt),
      enabledWith({ highImpactPatterns: ['pagin[ao]ci[oó]n'] }),
    ),
    null,
  );
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('EN verbs add/update count as implementation requests that need a LEVEL', () => {
  const prompts = [
    'Add a new payment method to the checkout flow for every customer.',
    'Update the auth token refresh so expired sessions are renewed silently.',
  ];
  for (const prompt of prompts) {
    assert.ok(isDeny(runGate(delegate(prompt), ENABLED)), prompt);
  }
});

test('highImpactPatterns [] turns the contradiction check off but still requires a LEVEL', () => {
  const options = enabledWith({ highImpactPatterns: [] });
  assert.equal(
    runGate(delegate(withLevel(LEVEL_MICRO_ES, MONEY_PROMPT)), options),
    null,
  );
  assert.ok(isDeny(runGate(delegate(MONEY_PROMPT), options)));
});

test('a string highImpactPatterns falls back to the defaults instead of denying everything', () => {
  const options = enabledWith({ highImpactPatterns: 'pago' });
  assert.ok(
    isDeny(runGate(delegate(withLevel(LEVEL_MICRO_ES, MONEY_PROMPT)), options)),
  );
  // The fallback also surfaces a one-time "ignored config param" warn, never a deny.
  assert.ok(
    !isDeny(
      runGate(delegate(withLevel(LEVEL_STANDARD_ES, LOW_RISK_PROMPT)), options),
    ),
  );
});

test('a LEVEL declared across a line break or after a qualifier is recognized', () => {
  assert.equal(
    runGate(
      delegate(withLevel('**LEVEL**\nSTANDARD', LOW_RISK_PROMPT)),
      ENABLED,
    ),
    null,
  );
  assert.equal(
    runGate(
      delegate(
        withLevel('Nivel de riesgo de esta tarea: STANDARD', LOW_RISK_PROMPT),
      ),
      ENABLED,
    ),
    null,
  );
});

test('HIGH RISK with a space is accepted as HIGH-RISK', () => {
  assert.equal(
    runGate(delegate(withLevel('LEVEL: HIGH RISK', MONEY_PROMPT)), ENABLED),
    null,
  );
});

test('a documentary request (a report on the payment flow) needs no LEVEL', () => {
  assert.equal(
    runGate(
      delegate('Write a report on the payment flow for the finance team.'),
      ENABLED,
    ),
    null,
  );
});

test('apostrophes are not quote delimiters: the intent between them still contradicts MICRO', () => {
  const prompt = withLevel(
    'LEVEL: MICRO',
    "Don't break anything: implement the new payment charge in the user's checkout.",
  );
  const result = runGate(delegate(prompt), ENABLED);
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /HIGH-RISK/);
});
