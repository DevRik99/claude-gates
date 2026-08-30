import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'test-matrix-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function delegate(prompt, subagentType = 'backend') {
  return {
    tool_name: 'Agent',
    tool_input: { prompt, subagent_type: subagentType },
  };
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

function enabledConfig(extraParameters) {
  return {
    gates: {
      requireTestMatrixWhenImplementing: extraParameters
        ? { enabled: true, ...extraParameters }
        : true,
    },
  };
}

test('disabled by default: a money-touching brief with no test matrix is allowed', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el cobro de la cuota.';
  assert.equal(runGate(delegate(prompt)), null);
});

test('denies missing unit/mutation on a plain brief with no test type declared', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.ok(isDeny(runGate(delegate(prompt), { config: enabledConfig() })));
});

test('denies missing E2E when the brief touches money and only declares unit tests', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el cobro de la cuota. Verificación: vitest cubre el cálculo.';
  assert.ok(isDeny(runGate(delegate(prompt), { config: enabledConfig() })));
});

test('allows a brief that declares unit, E2E and negative cases for a money domain', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el cobro de la cuota. ' +
    'Verificación: vitest cubre el cálculo. E2E: flujo completo de cobro. ' +
    'Casos negativos: monto cero, sin saldo, error de red.';
  assert.equal(runGate(delegate(prompt), { config: enabledConfig() }), null);
});

test('exempt subagent type (qa) is never held to the matrix requirement', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el cobro de la cuota.';
  assert.equal(
    runGate(delegate(prompt, 'qa'), { config: enabledConfig() }),
    null,
  );
});

test('denies missing E2E for a Spanish money brief (cobro/saldo/cuota), not just its English equivalent', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el cobro de la cuota. Verificación: vitest cubre el cálculo.';
  const result = runGate(delegate(prompt), { config: enabledConfig() });
  assert.ok(isDeny(result));
  assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('E2E'));
});

test('bilingual control: an EN money brief with only unit coverage denies for the same reason as its ES equivalent', () => {
  const es = 'Nivel: STANDARD\nImplementá el cobro de la cuota. Verificación: vitest cubre el cálculo.';
  const en = 'Level: STANDARD\nImplement the fee charge. Verification: vitest covers the calculation.';
  const resultEs = runGate(delegate(es), { config: enabledConfig() });
  const resultEn = runGate(delegate(en), { config: enabledConfig() });
  assert.ok(isDeny(resultEs));
  assert.ok(isDeny(resultEn));
  assert.ok(resultEs.hookSpecificOutput.permissionDecisionReason.includes('E2E'));
  assert.ok(resultEn.hookSpecificOutput.permissionDecisionReason.includes('E2E'));
});

test('allows a Spanish brief that declares unit, E2E and negative cases with Spanish wording', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el cobro de la cuota. ' +
    'Verificación: pruebas unitarias cubren el calculo. E2E: flujo completo de cobro. ' +
    'Casos negativos: monto cero, sin saldo, entrada invalida.';
  assert.equal(runGate(delegate(prompt), { config: enabledConfig() }), null);
});

test('e2eSignals param override makes a domain word mandatory that the default list omits', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el módulo de inventario. Verificación: vitest cubre el cálculo.';
  const config = enabledConfig({ e2eSignals: ['inventario|inventory'] });
  assert.ok(isDeny(runGate(delegate(prompt), { config })));
});
