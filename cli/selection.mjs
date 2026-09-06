// Pure selection logic: turns a mode plus the user's picks into the
// `gates` map (`configKey -> boolean`) that hooks read. No I/O here so it is
// fully testable without a terminal.

import { allGates } from './registry.mjs';

export const MODES = Object.freeze({
  ALL: 'all',
  FAMILIES: 'families',
  GRANULAR: 'granular',
  DEFAULTS: 'defaults',
  NONE: 'none',
  /**
   * Only what this config has never decided about. Resolves exactly like GRANULAR — by the
   * time picks arrive the user has already chosen from a list narrowed to the new gates —
   * but the caller builds that list with `newGatesFor`, so an upgrade can adopt what a
   * release added without re-answering, or silently flipping, anything already in the file.
   */
  NEW: 'new',
});

/**
 * The gates a config has never decided about: no entry under `gates` for their configKey.
 * An entry set to `false` counts as DECIDED — the user turned it off on purpose, and
 * offering it again as "new" would be how a deliberate opt-out gets undone by an upgrade.
 */
export function newGatesFor(registry, existingGates = {}) {
  const decided = new Set(Object.keys(existingGates ?? {}));
  return allGates(registry).filter((gate) => !decided.has(gate.configKey));
}

function assertKnown(chosen, known, kind) {
  const unknown = [...chosen].filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new Error(`Unknown ${kind} id(s): ${unknown.join(', ')}`);
}

/** mode → (gates, registry, picks) → Set of enabled gate ids */
const STRATEGIES = {
  [MODES.ALL]: (gates) => new Set(gates.map((gate) => gate.id)),
  [MODES.DEFAULTS]: (gates) =>
    new Set(gates.filter((gate) => gate.default).map((gate) => gate.id)),
  [MODES.NONE]: () => new Set(),
  [MODES.FAMILIES]: (gates, registry, picks) => {
    const chosen = new Set(picks.families ?? []);
    assertKnown(
      chosen,
      new Set(registry.families.map((family) => family.id)),
      'family',
    );
    return new Set(
      gates.filter((gate) => chosen.has(gate.family)).map((gate) => gate.id),
    );
  },
  [MODES.NEW]: (gates, _registry, picks) => {
    const chosen = new Set(picks.gates ?? []);
    assertKnown(chosen, new Set(gates.map((gate) => gate.id)), 'gate');
    return chosen;
  },
  [MODES.GRANULAR]: (gates, _registry, picks) => {
    const chosen = new Set(picks.gates ?? []);
    assertKnown(chosen, new Set(gates.map((gate) => gate.id)), 'gate');
    return chosen;
  },
};

/**
 * @param {object} registry validated registry
 * @param {string} mode one of MODES
 * @param {{ families?: string[], gates?: string[] }} picks family ids (FAMILIES) or gate ids (GRANULAR)
 * @returns {Record<string, boolean>} configKey -> enabled
 */
export function resolveSelection(registry, mode, picks = {}) {
  const strategy = STRATEGIES[mode];
  if (!strategy) throw new Error(`Unknown selection mode: ${mode}`);
  const gates = allGates(registry);
  const enabledIds = strategy(gates, registry, picks);
  const result = {};
  for (const gate of gates) result[gate.configKey] = enabledIds.has(gate.id);
  return result;
}

/** Adoption status derived from the resolved map — what `ask-adoption` reads later. */
export function adoptionOf(gatesMap) {
  const values = Object.values(gatesMap);
  if (values.length === 0 || values.every((enabled) => enabled === false))
    return false;
  if (values.every((enabled) => enabled === true)) return true;
  return 'partial';
}

/** Human summary grouped by family, for the confirmation step and the final report. */
export function summarize(registry, gatesMap) {
  return registry.families.map((family) => {
    const enabled = family.gates
      .filter((gate) => gatesMap[gate.configKey] === true)
      .map((gate) => gate.id);
    return {
      family: family.id,
      name: family.name,
      enabled,
      total: family.gates.length,
    };
  });
}

/** Config keys a run explicitly decided about: only these may change an existing entry. */
export function namedGatesFor(registry, mode, picks = {}) {
  const gates = allGates(registry);
  const keysOf = (predicate) =>
    new Set(gates.filter(predicate).map((gate) => gate.configKey));
  if (mode === MODES.ALL || mode === MODES.NONE) return keysOf(() => true);
  if (mode === MODES.DEFAULTS) return new Set();
  if (mode === MODES.FAMILIES) {
    const chosen = new Set(picks.families ?? []);
    return keysOf((gate) => chosen.has(gate.family));
  }
  if (mode === MODES.GRANULAR || mode === MODES.NEW) {
    const chosen = new Set(picks.gates ?? []);
    return keysOf((gate) => chosen.has(gate.id));
  }
  throw new Error(`Unknown selection mode: ${mode}`);
}
