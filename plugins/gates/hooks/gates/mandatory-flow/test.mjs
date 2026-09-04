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
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const ENABLED = { gates: { requireLiveTaskWhenImplementing: true } };
const POINTER = join('.ai', 'pipeline', 'ACTIVA');
const TASK = join('.ai', 'pipeline', 'checkout-flow');
const IMPLEMENT = 'Nivel: STANDARD\nImplementá el checkout.';

function run(files, { config = ENABLED, payload, cwd } = {}) {
  const project = makeProject({ config, files });
  return runGateProcess(GATE, payload ?? delegate(IMPLEMENT, 'backend'), {
    project,
    cwd: cwd ? join(project, cwd) : undefined,
  });
}

test('disabled by default: no pointer file needed', () => {
  assert.equal(run({}, { config: null }), null);
});

test('denies implementing when no active-task pointer exists on disk', () => {
  assert.ok(isDeny(run({})));
});

test('allows implementing when the active task has a contract on disk', () => {
  const files = {
    [POINTER]: 'checkout-flow',
    [join(TASK, 'asserts.md')]: '# Asserts\n\nCriterio: cobrar bien.',
  };
  assert.equal(run(files), null);
});

test('denies when the pointer names a task with no contract file', () => {
  const files = { [POINTER]: 'checkout-flow', [join(TASK, '.keep')]: '' };
  assert.ok(isDeny(run(files)));
});

test('exempt subagent type (qa) is never held to the live-task requirement', () => {
  assert.equal(run({}, { payload: delegate(IMPLEMENT, 'qa') }), null);
});

test('activePointerPath param override points the gate at a custom location', () => {
  const config = {
    gates: {
      requireLiveTaskWhenImplementing: {
        enabled: true,
        activePointerPath: join('.custom', 'ACTIVE'),
      },
    },
  };
  const files = {
    [POINTER]: 'checkout-flow',
    [join(TASK, 'asserts.md')]: 'Criterio: cobrar bien.',
  };
  assert.ok(isDeny(run(files, { config })));
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('the contract root follows an overridden pointer directory', () => {
  const config = {
    gates: {
      requireLiveTaskWhenImplementing: {
        enabled: true,
        activePointerPath: join('.custom', 'ACTIVE'),
      },
    },
  };
  const files = {
    [join('.custom', 'ACTIVE')]: 'checkout-flow',
    [join('.custom', 'checkout-flow', 'asserts.md')]: 'Criterio: cobrar bien.',
  };
  assert.equal(run(files, { config }), null);
});

test('an absolute activePointerPath is honored', () => {
  const project = makeProject({
    files: {
      [join('tasks', 'ACTIVE')]: 'checkout-flow',
      [join('tasks', 'checkout-flow', 'asserts.md')]: 'Criterio: cobrar bien.',
    },
  });
  const config = {
    gates: {
      requireLiveTaskWhenImplementing: {
        enabled: true,
        activePointerPath: join(project, 'tasks', 'ACTIVE'),
      },
    },
  };
  const runner = makeProject({ config });
  assert.equal(
    runGateProcess(GATE, delegate(IMPLEMENT, 'backend'), { project: runner }),
    null,
  );
});

test('an empty contract file does not count as a contract', () => {
  const files = { [POINTER]: 'checkout-flow', [join(TASK, 'asserts.md')]: '' };
  const result = run(files);
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /no non-empty contract/);
});

test('the pointer is resolved from the project root, not the cwd', () => {
  const files = {
    [POINTER]: 'checkout-flow',
    [join(TASK, 'asserts.md')]: 'Criterio: cobrar bien.',
    [join('packages', 'web', '.keep')]: '',
  };
  assert.equal(run(files, { cwd: join('packages', 'web') }), null);
});

test('an app path under src/hooks/ is not harness work', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el hook en src/hooks/useCheckout.ts para el carrito.';
  assert.ok(isDeny(run({}, { payload: delegate(prompt, 'backend') })));
});

test('real harness work (CLAUDE.md) is exempt', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá la nueva regla en CLAUDE.md del repositorio.';
  assert.equal(run({}, { payload: delegate(prompt, 'backend') }), null);
});

test('the exempt list is case-insensitive and unknown types are builders', () => {
  assert.equal(run({}, { payload: delegate(IMPLEMENT, 'QA') }), null);
  assert.ok(isDeny(run({}, { payload: delegate(IMPLEMENT, 'wizard') })));
  assert.ok(isDeny(run({}, { payload: delegate(IMPLEMENT) })));
});

test('a decoy LEVEL: MICRO before the operative HIGH-RISK does not exempt', () => {
  const prompt =
    'Nivel: MICRO (tarea anterior). Nivel: HIGH-RISK\nImplementá el checkout.';
  assert.ok(isDeny(run({}, { payload: delegate(prompt, 'backend') })));
});
