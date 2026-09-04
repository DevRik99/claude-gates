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

function builder(prompt, subagentType = 'backend') {
  return delegate(prompt, subagentType);
}

function enabled(extraParameters) {
  return {
    config: {
      gates: {
        requireTestMatrixWhenImplementing: extraParameters
          ? { enabled: true, ...extraParameters }
          : true,
      },
    },
  };
}

const MONEY_UNIT_ONLY =
  'Nivel: STANDARD\nImplementá el cobro de la cuota. Verificación: vitest cubre el cálculo.';
const UNIT_AND_NEGATIVE =
  'Verificación: vitest cubre el cálculo. Casos negativos: entrada invalida, error de red.';

// Spanish fixtures are joined from plain strings: template literals are spell-checked.
function brief(task, ...extra) {
  return ['Nivel: STANDARD', task, UNIT_AND_NEGATIVE, ...extra].join(' ');
}

test('disabled by default: a money-touching brief with no test matrix is allowed', () => {
  assert.equal(
    runGate(builder('Nivel: STANDARD\nImplementá el cobro de la cuota.')),
    null,
  );
});

test('denies missing unit/mutation on a plain brief with no test type declared', () => {
  assert.ok(
    isDeny(
      runGate(builder('Nivel: STANDARD\nImplementá el checkout.'), enabled()),
    ),
  );
});

test('denies missing E2E when the brief touches money and only declares unit tests', () => {
  assert.ok(isDeny(runGate(builder(MONEY_UNIT_ONLY), enabled())));
});

test('allows a brief that declares unit, E2E and negative cases for a money domain', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el cobro de la cuota. ' +
    'Verificación: vitest cubre el cálculo. E2E: flujo completo de cobro. ' +
    'Casos negativos: monto cero, sin saldo, error de red.';
  assert.equal(runGate(builder(prompt), enabled()), null);
});

test('exempt subagent type (qa) is never held to the matrix requirement', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el cobro de la cuota.';
  assert.equal(runGate(builder(prompt, 'qa'), enabled()), null);
});

test('denies missing E2E for a Spanish money brief (cobro/saldo/cuota), not just its English equivalent', () => {
  const result = runGate(builder(MONEY_UNIT_ONLY), enabled());
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /E2E/);
});

test('bilingual control: an EN money brief with only unit coverage denies for the same reason as its ES equivalent', () => {
  const en =
    'Level: STANDARD\nImplement the fee charge. Verification: vitest covers the calculation.';
  const resultEs = runGate(builder(MONEY_UNIT_ONLY), enabled());
  const resultEn = runGate(builder(en), enabled());
  assert.ok(isDeny(resultEs));
  assert.ok(isDeny(resultEn));
  assert.match(messageOf(resultEs), /E2E/);
  assert.match(messageOf(resultEn), /E2E/);
});

test('allows a Spanish brief that declares unit, E2E and negative cases with Spanish wording', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el cobro de la cuota. ' +
    'Verificación: pruebas unitarias cubren el calculo. E2E: flujo completo de cobro. ' +
    'Casos negativos: monto cero, sin saldo, entrada invalida.';
  assert.equal(runGate(builder(prompt), enabled()), null);
});

test('e2eSignals param override makes a domain word mandatory that the default list omits', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el módulo de inventario. Verificación: vitest cubre el cálculo.';
  const options = enabled({ e2eSignals: ['inventario|inventory'] });
  assert.ok(isDeny(runGate(builder(prompt), options)));
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('a file extension in a real path makes the visual/QA row mandatory', () => {
  const prompt = brief('Implementá src/Checkout.tsx.');
  const result = runGate(builder(prompt), enabled());
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /visual\/QA/);
});

test('generic words (role, balance, session, token) no longer make E2E mandatory', () => {
  const prompt = brief(
    'Implement the role of this module and its session cache.',
  );
  assert.equal(runGate(builder(prompt), enabled()), null);
});

test('e2eSignals [] means E2E is never mandatory', () => {
  const prompt = brief('Implementá el cobro de la cuota.');
  assert.equal(runGate(builder(prompt), enabled({ e2eSignals: [] })), null);
});

test('"QA:" alone is not a visual row; "QA:" followed by content is', () => {
  const base = 'Implementá el formulario de alta.';
  const bare = runGate(builder(brief(base, 'QA:')), enabled());
  assert.ok(isDeny(bare));
  assert.match(messageOf(bare), /visual\/QA/);
  assert.equal(
    runGate(builder(brief(base, 'QA: revisado en el navegador.')), enabled()),
    null,
  );
});

test('a malformed signal entry is skipped and the valid ones still apply', () => {
  const options = enabled({ e2eSignals: ['(', 'inventario'] });
  const prompt =
    'Nivel: STANDARD\nImplementá el módulo de inventario. Verificación: vitest cubre el cálculo.';
  assert.ok(isDeny(runGate(builder(prompt), options)));
});

test('an app path under src/hooks/ is not harness work', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el hook en src/hooks/useCheckout.ts para el carrito.';
  assert.ok(isDeny(runGate(builder(prompt), enabled())));
});

test('real harness work (.ai/) is exempt', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el ajuste en .ai/config.json.';
  assert.equal(runGate(builder(prompt), enabled()), null);
});

test('the exempt list is case-insensitive and unknown types are builders', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.equal(runGate(builder(prompt, 'QA'), enabled()), null);
  assert.ok(isDeny(runGate(builder(prompt, 'wizard'), enabled())));
  assert.ok(isDeny(runGate(delegate(prompt), enabled())));
});

test('a decoy LEVEL: MICRO before the operative HIGH-RISK does not exempt', () => {
  const prompt =
    'Nivel: MICRO (tarea anterior). Nivel: HIGH-RISK\nImplementá el checkout.';
  assert.ok(isDeny(runGate(builder(prompt), enabled())));
});
