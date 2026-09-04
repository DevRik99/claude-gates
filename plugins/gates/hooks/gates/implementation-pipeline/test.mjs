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
        requireImplementationPipeline: extraParameters
          ? { enabled: true, ...extraParameters }
          : true,
      },
    },
  };
}

const NO_STAGES = 'Nivel: STANDARD\nImplementá el checkout.';
const ALL_STAGES =
  'Nivel: STANDARD\nImplementá el checkout. Contexto verificado: .ai/features/checkout/brief.md. ' +
  'Verificación: npm test debe pasar. Revisión: el principal revisa el diff antes de cerrar.';

test('disabled by default: a builder delegation with no pipeline stages is allowed', () => {
  assert.equal(runGate(builder(NO_STAGES)), null);
});

test('denies a builder delegation missing all three pipeline stages', () => {
  assert.ok(isDeny(runGate(builder(NO_STAGES), enabled())));
});

test('allows a builder delegation that declares all three stages', () => {
  assert.equal(runGate(builder(ALL_STAGES), enabled()), null);
});

test('exempt subagent type (scout) is never held to the pipeline', () => {
  assert.equal(runGate(builder(NO_STAGES, 'scout'), enabled()), null);
});

test('a prompt that only describes, does not order, is exempt via QUESTION level', () => {
  const prompt = 'Nivel: QUESTION\nExplicá cómo funciona el checkout hoy.';
  assert.equal(runGate(builder(prompt), enabled()), null);
});

test('builderSubagents override: a custom type is held to the pipeline', () => {
  const options = enabled({ builderSubagents: ['custom-builder'] });
  assert.ok(isDeny(runGate(builder(NO_STAGES, 'custom-builder'), options)));
  // Changed from the audit: a type outside the builder list used to be exempt, which let
  // any unknown label skip the pipeline. Now only the exempt list exempts.
  assert.ok(isDeny(runGate(builder(NO_STAGES, 'backend'), options)));
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('an app path under src/hooks/ is not harness work', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el hook en src/hooks/useCheckout.ts para el carrito.';
  assert.ok(isDeny(runGate(builder(prompt), enabled())));
});

test('.vscode/settings.json is not harness work', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el formateo automático en .vscode/settings.json del repo.';
  assert.ok(isDeny(runGate(builder(prompt), enabled())));
});

test('real harness work (.claude/) is exempt', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el hook nuevo en .claude/hooks/pre-commit.mjs.';
  assert.equal(runGate(builder(prompt), enabled()), null);
});

test('a negated mention does not satisfy the WRITING stage', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el checkout. Contexto verificado: brief.md. Do not write tests. ' +
    'Revisión: el principal revisa el diff.';
  const result = runGate(builder(prompt), enabled());
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /WRITING/);
});

test('a negated mention does not satisfy the DEFINITION stage', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el checkout, no brief.md yet. Verificación: npm test. ' +
    'Revisión: el principal revisa el diff.';
  const result = runGate(builder(prompt), enabled());
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /DEFINITION/);
});

test('absent and unknown subagent types are both builders', () => {
  assert.ok(isDeny(runGate(delegate(NO_STAGES), enabled())));
  assert.ok(isDeny(runGate(builder(NO_STAGES, 'wizard'), enabled())));
});

test('the exempt list is case-insensitive', () => {
  assert.equal(runGate(builder(NO_STAGES, 'Scout'), enabled()), null);
});

test('adjacent verbs separated by a comma are still recognized', () => {
  const prompt = 'Nivel: STANDARD\nfix,add the checkout totals.';
  assert.ok(isDeny(runGate(builder(prompt), enabled())));
});

test('a decoy LEVEL: MICRO before the operative HIGH-RISK does not exempt', () => {
  const prompt =
    'Nivel: MICRO (tarea anterior). Nivel: HIGH-RISK\nImplementá el checkout.';
  const result = runGate(builder(prompt), enabled());
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /HIGH-RISK/);
});
