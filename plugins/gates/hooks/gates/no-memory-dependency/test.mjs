import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { delegate, isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

const ENABLED = { config: { gates: { warnMemoryDependencyInBrief: true } } };

function enabledWith(parameters) {
  return {
    config: {
      gates: { warnMemoryDependencyInBrief: { enabled: true, ...parameters } },
    },
  };
}

// The defaults now match references to PRIOR CONVERSATION only, so the fixtures cite one
// ("como hablamos") instead of the old "acordate de" imperative, which is no longer a signal.
const MEMORY_PROMPT = 'Como hablamos antes, aplica el mismo criterio.';

test('DENIES when the brief leans on remembered context (now a hard block)', () => {
  assert.ok(isDeny(runGate(delegate(MEMORY_PROMPT), ENABLED)));
});

test('escape hatch: the marker lets a false-positive memory phrase through', () => {
  assert.ok(
    isDeny(
      runGate(delegate('Como te dije, cerra el server al terminar.'), ENABLED),
    ),
  );
  assert.equal(
    runGate(
      delegate('Como te dije, cerra el server al terminar. memory-not-needed'),
      ENABLED,
    ),
    null,
  );
});

test('allows a brief with no memory-dependency phrase', () => {
  assert.equal(
    runGate(
      delegate('Implementa el endpoint de login segun el contrato adjunto.'),
      ENABLED,
    ),
    null,
  );
});

test('allows a memory phrase paired with a deterministic persistence instruction', () => {
  assert.equal(
    runGate(
      delegate(
        'Como quedamos, guarda la decision en .ai/decision.md antes de continuar.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(delegate(MEMORY_PROMPT), {
      config: { gates: { warnMemoryDependencyInBrief: false } },
    }),
    null,
  );
});

test('project memoryDependencyPatterns override replaces the built-in list', () => {
  const options = enabledWith({ memoryDependencyPatterns: ['como quedamos'] });
  assert.equal(runGate(delegate(MEMORY_PROMPT), options), null);
  assert.ok(
    isDeny(runGate(delegate('Hacelo como quedamos la ultima vez.'), options)),
  );
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('an instruction that carries its own content is not a memory dependency', () => {
  const prompts = [
    "Don't forget to update the CHANGELOG before you open the pull request.",
    'Keep in mind that this repo uses pnpm, not npm, for every script.',
    'Remember to run the tests before you finish.',
  ];
  for (const prompt of prompts) {
    assert.equal(runGate(delegate(prompt), ENABLED), null, prompt);
  }
});

test('English references to prior conversation are denied', () => {
  const prompts = [
    'As we discussed, apply the same fix to the checkout module.',
    'Use the one from before for the config loader.',
    'Do what we decided about the retry policy.',
  ];
  for (const prompt of prompts) {
    assert.ok(isDeny(runGate(delegate(prompt), ENABLED)), prompt);
  }
});

test('memoryDependencyPatterns [] means nothing matches', () => {
  assert.equal(
    runGate(
      delegate(MEMORY_PROMPT),
      enabledWith({ memoryDependencyPatterns: [] }),
    ),
    null,
  );
});

test('a malformed pattern entry is skipped and the valid ones still apply', () => {
  const options = enabledWith({
    memoryDependencyPatterns: ['(', 'como quedamos'],
  });
  assert.ok(
    isDeny(runGate(delegate('Hacelo como quedamos la ultima vez.'), options)),
  );
});

test('a numeric escapeHatch falls back to the default marker instead of crashing', () => {
  const options = enabledWith({ escapeHatch: 123 });
  assert.ok(isDeny(runGate(delegate(MEMORY_PROMPT), options)));
  assert.ok(
    !isDeny(runGate(delegate(`${MEMORY_PROMPT} memory-not-needed`), options)),
  );
});

test('a persistence verb only suppresses when it is a real verb, not a substring', () => {
  assert.ok(
    isDeny(
      runGate(
        delegate('Como hablamos, restore the snapshot and continue.'),
        ENABLED,
      ),
    ),
  );
});
