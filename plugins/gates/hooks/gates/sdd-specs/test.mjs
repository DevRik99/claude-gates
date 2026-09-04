import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  delegate,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const CATALOG = join('.ai', 'feature_list.json');
const EMPTY_CATALOG = JSON.stringify({ features: [] });
const BRIEF = join('.ai', 'features', 'checkout', 'brief.md');
const ENABLED = { gates: { requireSpecBeforeImplementing: true } };
const IMPLEMENT_CHECKOUT =
  'Nivel: STANDARD\nImplementá .ai/features/checkout/ el flujo de pago.';

function runGate(project, payload) {
  return runGateProcess(GATE, payload, { project });
}

function builder(prompt, subagentType = 'backend') {
  return delegate(prompt, subagentType);
}

function scratch({ config = ENABLED, files = {} } = {}) {
  return makeProject({ config, files });
}

test('auto-off: no catalog anywhere allows implementation delegation', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el checkout citando .ai/features/checkout/tasks/t1/';
  assert.equal(runGate(scratch(), builder(prompt)), null);
});

test('denies an implementation delegation citing a feature with no contract on disk', () => {
  const root = scratch({
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  assert.ok(isDeny(runGate(root, builder(IMPLEMENT_CHECKOUT))));
});

test('allows an implementation delegation citing a feature with a non-empty contract', () => {
  const root = scratch({
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [BRIEF]: '# Checkout\n\nObjetivo: cobrar.',
    },
  });
  assert.equal(runGate(root, builder(IMPLEMENT_CHECKOUT)), null);
});

test('disabled by config: the gate does not run', () => {
  const root = scratch({
    config: { gates: { requireSpecBeforeImplementing: false } },
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  assert.equal(runGate(root, builder(IMPLEMENT_CHECKOUT)), null);
});

test('a prompt that only describes, does not order, is exempt via QUESTION level', () => {
  const root = scratch({
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  const prompt =
    'Nivel: QUESTION\nExplicá cómo funciona .ai/features/checkout/ hoy.';
  assert.equal(runGate(root, builder(prompt)), null);
});

test('exemptSubagents param override exempts a custom subagent type', () => {
  const root = scratch({
    config: {
      gates: {
        requireSpecBeforeImplementing: {
          enabled: true,
          exemptSubagents: ['worker'],
        },
      },
    },
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  assert.equal(runGate(root, builder(IMPLEMENT_CHECKOUT, 'worker')), null);
});

test('a catalog write moving a feature to spec_ready without contract is denied', () => {
  const root = scratch({
    files: { [CATALOG]: EMPTY_CATALOG, [join('.ai', 'features', '.keep')]: '' },
  });
  const payload = write(
    join(root, CATALOG),
    JSON.stringify({ features: [{ name: 'checkout', status: 'spec_ready' }] }),
  );
  assert.ok(isDeny(runGate(root, payload)));
});

test('a feature entry with an advanced status but no name field is denied, not silently skipped', () => {
  const root = scratch({
    files: { [CATALOG]: EMPTY_CATALOG, [join('.ai', 'features', '.keep')]: '' },
  });
  const payload = write(
    join(root, CATALOG),
    JSON.stringify({ features: [{ status: 'spec_ready' }] }),
  );
  const result = runGate(root, payload);
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /no 'name' field/);
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('a delegation citing two features is denied when only one of them has a contract', () => {
  const root = scratch({
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [BRIEF]: '# Checkout',
      [join('.ai', 'features', 'refunds', '.keep')]: '',
    },
  });
  const prompt =
    'Nivel: STANDARD\nImplementá .ai/features/checkout/ y .ai/features/refunds/ juntos.';
  const result = runGate(root, builder(prompt));
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /refunds ->/);
  assert.doesNotMatch(messageOf(result), /checkout ->/);
});

test('a catalogLocations override still checks writes to that catalog', () => {
  const root = scratch({
    config: {
      gates: {
        requireSpecBeforeImplementing: {
          enabled: true,
          catalogLocations: ['specs/catalog.json'],
        },
      },
    },
    files: {
      [join('specs', 'catalog.json')]: EMPTY_CATALOG,
      [join('specs', 'features', '.keep')]: '',
    },
  });
  const payload = write(
    join(root, 'specs', 'catalog.json'),
    JSON.stringify({ features: [{ name: 'checkout', status: 'spec_ready' }] }),
  );
  assert.ok(isDeny(runGate(root, payload)));
});

test('the exempt subagent list is case-insensitive', () => {
  const root = scratch({
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  assert.equal(runGate(root, builder(IMPLEMENT_CHECKOUT, 'Explore')), null);
});

test('a decoy LEVEL: MICRO before the operative HIGH-RISK does not exempt', () => {
  const root = scratch({
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  const prompt =
    'Nivel: MICRO (tarea anterior). Nivel: HIGH-RISK\nImplementá .ai/features/checkout/ el flujo de pago.';
  assert.ok(isDeny(runGate(root, builder(prompt))));
});

test('the catalog is found from a subdirectory of the project (root, not cwd)', () => {
  const root = scratch({
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
      [join('packages', 'web', '.keep')]: '',
    },
  });
  const result = runGateProcess(GATE, builder(IMPLEMENT_CHECKOUT), {
    project: root,
    cwd: join(root, 'packages', 'web'),
  });
  assert.ok(isDeny(result));
});
