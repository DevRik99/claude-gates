// materializeGates only computes the NEW selection's map; how much of an existing gate
// entry survives depends on the run's mode. This test exercises that combination the same
// way init.mjs does — a bug here reads as "materialize wiped my config" even though
// materializeGates and mergeConfig are individually simple.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeConfig } from '../config.mjs';
import { materializeGates } from '../materialize.mjs';
import { loadRegistry, allGates } from '../registry.mjs';
import { resolveSelection, MODES } from '../selection.mjs';

const registry = loadRegistry();
const gates = allGates(registry);
const paramGate = gates.find(
  (gate) => Array.isArray(gate.params) && gate.params.length > 0,
);

function mergedGatesAfter(mode, existingGates) {
  const existing = {
    adopted: 'partial',
    gateVersion: registry.gateVersion,
    gates: existingGates,
  };
  const selection = resolveSelection(registry, mode, {
    gates: [paramGate.id],
    families: [paramGate.family],
  });
  const materialized = materializeGates(registry, selection, existing.gates, mode);
  return mergeConfig(existing, {
    adopted: 'partial',
    gates: materialized,
    gateVersion: registry.gateVersion,
  }).gates;
}

test('registry has at least one gate with params, for these tests to exercise', () => {
  assert.ok(paramGate, 'registry must have at least one gate with params');
});

test('DEFAULTS re-run preserves a gate the user already disabled, with its custom params, untouched', () => {
  const merged = mergedGatesAfter(MODES.DEFAULTS, {
    [paramGate.configKey]: { enabled: false, __userTuned: 'kept-value' },
  });

  assert.equal(
    merged[paramGate.configKey].enabled,
    false,
    'a gate the user disabled must stay disabled after a defaults re-run',
  );
  assert.equal(
    merged[paramGate.configKey].__userTuned,
    'kept-value',
    "the user's own param edit must not be replaced by the gate's built-in default",
  );

  const untouched = gates.find((gate) => gate.configKey !== paramGate.configKey);
  assert.ok(
    Object.prototype.hasOwnProperty.call(merged, untouched.configKey),
    'a gate absent from the existing config must still appear after materializing',
  );
});

test('an explicit GRANULAR pick overrides a previously disabled gate: the named choice wins', () => {
  const merged = mergedGatesAfter(MODES.GRANULAR, {
    [paramGate.configKey]: { enabled: false, __userTuned: 'kept-value' },
  });

  assert.equal(
    merged[paramGate.configKey].enabled,
    true,
    'naming a gate in --gates must re-enable it even if the config had it disabled',
  );
});

test('an explicit GRANULAR pick still preserves the user\'s own params (no new values were passed)', () => {
  const merged = mergedGatesAfter(MODES.GRANULAR, {
    [paramGate.configKey]: { enabled: false, __userTuned: 'kept-value' },
  });

  assert.equal(
    merged[paramGate.configKey].__userTuned,
    'kept-value',
    'params the user tuned by hand survive an explicit pick that only changes enabled',
  );
});

test('FAMILIES mode behaves the same as GRANULAR for an already-configured gate', () => {
  const merged = mergedGatesAfter(MODES.FAMILIES, {
    [paramGate.configKey]: { enabled: false, __userTuned: 'kept-value' },
  });

  assert.equal(merged[paramGate.configKey].enabled, true);
  assert.equal(merged[paramGate.configKey].__userTuned, 'kept-value');
});
