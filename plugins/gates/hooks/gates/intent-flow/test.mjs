import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'intent-flow-'));
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

function delegate(prompt, extra = {}) {
  return { tool_name: 'Agent', tool_input: { prompt, ...extra } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLED = {
  config: { gates: { requireScopeListBeforeDelegating: true } },
};

test('denies implementing a payment change with real intent and no scope list', () => {
  const result = runGate(
    delegate(
      'Implementa el cobro del pago con la nueva pasarela de dinero para el checkout.',
    ),
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('allows the same request once IN SCOPE / OUT OF SCOPE / EDGE CASES are declared', () => {
  const prompt = [
    'Implementa el cobro del pago con la nueva pasarela de dinero para el checkout.',
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

test('allows a read-only subagent', () => {
  assert.equal(
    runGate(
      delegate(
        'Implementa el cobro del pago con la nueva pasarela de dinero.',
        {
          subagent_type: 'plan',
        },
      ),
      ENABLED,
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(
      delegate('Implementa el cobro del pago con la nueva pasarela de dinero.'),
      {
        config: { gates: { requireScopeListBeforeDelegating: false } },
      },
    ),
    null,
  );
});

test('project highImpactPatterns override narrows what counts as high-impact', () => {
  const config = {
    gates: {
      requireScopeListBeforeDelegating: {
        enabled: true,
        highImpactPatterns: ['pagin[ao]ci[oó]n'],
      },
    },
  };
  const prompt =
    'Implementa el cobro del pago con la nueva pasarela de dinero.';
  // With the default patterns (money/payment), this same prompt is denied.
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
  // No longer matches "dinero/pago" as high-impact once overridden, so no scope list
  // is required and the gate allows.
  assert.equal(runGate(delegate(prompt), { config }), null);
});
