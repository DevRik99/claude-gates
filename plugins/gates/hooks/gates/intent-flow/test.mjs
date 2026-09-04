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

function enabledWith(parameters) {
  return {
    config: {
      gates: {
        requireScopeListBeforeDelegating: { enabled: true, ...parameters },
      },
    },
  };
}

const MONEY_PROMPT =
  'Implementa el cobro del pago con la nueva pasarela de dinero para el checkout.';

test('denies implementing a payment change with real intent and no scope list', () => {
  assert.ok(isDeny(runGate(delegate(MONEY_PROMPT), ENABLED)));
});

test('bilingual control: an EN payment brief with no scope list denies exactly like its ES equivalent', () => {
  const en = delegate(
    'Implement the payment charge with the new money gateway for checkout.',
  );
  assert.ok(isDeny(runGate(delegate(MONEY_PROMPT), ENABLED)));
  assert.ok(isDeny(runGate(en, ENABLED)));
});

test('allows the same request once IN SCOPE / OUT OF SCOPE / EDGE CASES are declared', () => {
  const prompt = [
    MONEY_PROMPT,
    '',
    'QUE SI (alcance): integrar el nuevo proveedor de pago en el checkout.',
    'QUE NO (fuera de alcance): no tocar el flujo de reembolsos.',
    'EDGE CASES: no aplican casos borde adicionales.',
  ].join('\n');
  assert.equal(runGate(delegate(prompt), ENABLED), null);
});

test('denies hard when a high-impact request declares an unresolved unknown', () => {
  const prompt = [
    'Implementa el cobro del pago con la nueva pasarela; todavia no esta claro que hacer con reembolsos parciales, unknown.',
    'QUE SI: cobro basico. QUE NO: reembolsos. EDGE CASES: ninguno.',
  ].join('\n');
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
});

test('allows a request mentioning payment only as documentation topic', () => {
  assert.equal(
    runGate(
      delegate(
        'Crea un documento README.md que explique como funciona el pago y la autenticacion del sistema para el equipo nuevo.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('allows a normal implementation request with no high-impact signal', () => {
  assert.equal(
    runGate(
      delegate(
        'Arregla el boton que no cambia de color al pasar el mouse en la pagina de inicio.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('allows a read-only subagent when the prompt carries no mutation-risk signal', () => {
  assert.equal(
    runGate(
      delegate('Explica como funciona el flujo de checkout actual.', 'plan'),
      ENABLED,
    ),
    null,
  );
});

test('a read-only subagent name no longer exempts a real money-mutation prompt', () => {
  assert.ok(isDeny(runGate(delegate(MONEY_PROMPT, 'plan'), ENABLED)));
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(delegate(MONEY_PROMPT), {
      config: { gates: { requireScopeListBeforeDelegating: false } },
    }),
    null,
  );
});

test('project highImpactPatterns override narrows what counts as high-impact', () => {
  assert.ok(isDeny(runGate(delegate(MONEY_PROMPT), ENABLED)));
  assert.equal(
    runGate(
      delegate(MONEY_PROMPT),
      enabledWith({ highImpactPatterns: ['pagin[ao]ci[oó]n'] }),
    ),
    null,
  );
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('EN verbs add/create/delete count as implementation requests', () => {
  const prompts = [
    'Add a new payment method to the checkout flow for every customer account.',
    'Create an auth middleware that validates the session token on each request.',
    'Delete the old production migration files and drop the unused schema tables.',
  ];
  for (const prompt of prompts) {
    assert.ok(isDeny(runGate(delegate(prompt), ENABLED)), prompt);
  }
});

test('highImpactPatterns [] means nothing is high-impact, so every prompt is allowed', () => {
  assert.equal(
    runGate(delegate(MONEY_PROMPT), enabledWith({ highImpactPatterns: [] })),
    null,
  );
});

test('a malformed highImpactPatterns entry is skipped and the valid ones still apply', () => {
  const options = enabledWith({
    highImpactPatterns: ['(', 'pagin[ao]ci[oó]n'],
  });
  assert.ok(
    isDeny(
      runGate(
        delegate('Implementa la paginacion de la tabla de usuarios del panel.'),
        options,
      ),
    ),
  );
  assert.equal(runGate(delegate(MONEY_PROMPT), options), null);
});

test('a non-array highImpactPatterns falls back to the defaults instead of denying everything', () => {
  const options = enabledWith({ highImpactPatterns: 'pago' });
  assert.ok(isDeny(runGate(delegate(MONEY_PROMPT), options)));
  // The fallback also surfaces a one-time "ignored config param" warn, never a deny.
  assert.ok(
    !isDeny(
      runGate(
        delegate(
          'Arregla el boton que no cambia de color al pasar el mouse en la pagina de inicio.',
        ),
        options,
      ),
    ),
  );
});

test('apostrophes are not quote delimiters: the real intent between them is still judged', () => {
  const prompt =
    "Don't break anything: implement the new payment charge in the user's checkout flow.";
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
});
