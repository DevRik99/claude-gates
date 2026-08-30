import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'risk-level-'));
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

const ENABLED = { config: { gates: { requireDeclaredRiskLevel: true } } };

test('denies an implementation delegation with no declared level', () => {
  assert.ok(
    isDeny(
      runGate(
        delegate('Arregla el boton que no cambia de color en la pagina.'),
        ENABLED,
      ),
    ),
  );
});

test('allows a declared level consistent with a low-risk request', () => {
  assert.equal(
    runGate(
      delegate(
        'NIVEL: STANDARD\n\nArregla el boton que no cambia de color en la pagina.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('denies a declared level that contradicts a real high-impact signal', () => {
  assert.ok(
    isDeny(
      runGate(
        delegate(
          'NIVEL: MICRO\n\nImplementa el cobro del pago con la nueva pasarela de dinero.',
        ),
        ENABLED,
      ),
    ),
  );
});

test('allows HIGH-RISK declared for a high-impact request', () => {
  assert.equal(
    runGate(
      delegate(
        'NIVEL: HIGH-RISK\n\nImplementa el cobro del pago con la nueva pasarela de dinero.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('bilingual control: an EN money-mutation brief contradicts a low level exactly like its ES equivalent', () => {
  const es = delegate(
    'NIVEL: MICRO\n\nImplementa el cobro del pago con la nueva pasarela de dinero.',
  );
  const en = delegate(
    'LEVEL: MICRO\n\nImplement the payment charge with the new money gateway.',
  );
  assert.ok(isDeny(runGate(es, ENABLED)));
  assert.ok(isDeny(runGate(en, ENABLED)));
});

// A whitelisted read-only subagent name is now void whenever the prompt itself carries
// a mutation-risk signal (money/auth/data/write/deploy): the label is self-declared,
// never a verified capability, and a real risk signal in the text must win over it
// (bug fixed in this gate; see risk-level.edge.test.mjs).
test('allows a read-only subagent without a declared level when the prompt carries no mutation-risk signal', () => {
  assert.equal(
    runGate(
      delegate('Explica como funciona el flujo de checkout actual.', {
        subagent_type: 'explore',
      }),
      ENABLED,
    ),
    null,
  );
});

test('a read-only subagent name no longer exempts a real money-mutation prompt from declaring a level', () => {
  assert.ok(
    isDeny(
      runGate(
        delegate(
          'Implementa el cobro del pago con la nueva pasarela de dinero.',
          {
            subagent_type: 'explore',
          },
        ),
        ENABLED,
      ),
    ),
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(delegate('Arregla el boton que no cambia de color en la pagina.'), {
      config: { gates: { requireDeclaredRiskLevel: false } },
    }),
    null,
  );
});

test('project highImpactPatterns override narrows what forces HIGH-RISK', () => {
  const config = {
    gates: {
      requireDeclaredRiskLevel: {
        enabled: true,
        highImpactPatterns: ['pagin[ao]ci[oó]n'],
      },
    },
  };
  const prompt =
    'NIVEL: MICRO\n\nImplementa el cobro del pago con la nueva pasarela de dinero.';
  // With the default patterns (money/payment), MICRO contradicts the signal and is denied.
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
  // Once overridden, "dinero/pago" no longer counts as high-impact, so MICRO is allowed.
  assert.equal(runGate(delegate(prompt), { config }), null);
});
