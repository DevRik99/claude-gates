// Materializes each gate's default params into the config that `init` writes, so every
// configurable value (a whitelist, a pattern list, a threshold) lands in the user's
// .ai/config.json ready to edit. The values come from the gates themselves — each gate,
// run with CLAUDE_GATES_DUMP_DEFAULTS set, prints its own defaults — so there is a single
// source of truth (the gate) and nothing is duplicated in the registry.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REPOSITORY_ROOT } from './constants.mjs';
import { allGates } from './registry.mjs';
import { MODES } from './selection.mjs';

const DUMP_ENV = 'CLAUDE_GATES_DUMP_DEFAULTS';

/** A gate's `hooks/` directory: each plugin (registry's per-family `plugin`) owns its own. */
function pluginHooksDirectory(pluginName) {
  return join(REPOSITORY_ROOT, 'plugins', pluginName, 'hooks');
}

/**
 * Runs one gate in defaults-dump mode and returns its built-in params. Not every gate
 * supports the defaults-dump protocol (only the `gates` plugin's PreToolUse gates do, via
 * runGate in hook-io.mjs); a script that does not recognize the env var, does not exist, or
 * errors for any other reason yields {} rather than aborting the whole init — the same
 * fallback already relied on before multi-plugin support.
 */
function defaultParametersOf(gate) {
  try {
    const out = execFileSync(
      process.execPath,
      [join(pluginHooksDirectory(gate.plugin), gate.script)],
      { encoding: 'utf8', env: { ...process.env, [DUMP_ENV]: '1' } },
    );
    return JSON.parse(out).defaultParams ?? {};
  } catch {
    return {};
  }
}

/** The existing entry's params, stripped of `enabled` — {} for a boolean or missing entry. */
function existingParametersOf(existingEntry) {
  if (!existingEntry || typeof existingEntry !== 'object') return {};
  const parameters = { ...existingEntry };
  delete parameters.enabled;
  return parameters;
}

/**
 * Turns the flat `{ configKey: enabled }` selection into the config's gates map. A gate
 * that declares params (per the registry) becomes `{ enabled, ...defaults }` so its knobs
 * are visible and editable; a gate with no params stays a plain boolean, keeping the file
 * compact. Only gates with params are spawned, so paramless selections cost nothing.
 *
 * `existingGates` (the project's current config, if any) and `mode` (the selection mode
 * this run used) together decide how much of an already-present gate survives:
 *
 *   - mode === DEFAULTS: a "fill the gaps" sweep, not a directed choice. A gate already in
 *     `existingGates` is carried over VERBATIM (enabled + every param) — materializing
 *     defaults must never be what resets a disablement or a custom pattern list the user
 *     deliberately set.
 *   - any other mode (ALL / FAMILIES / GRANULAR): the user named this gate (directly, or
 *     via its family) this run, so `enabled` follows the new selection — that is the whole
 *     point of picking it. Its PARAMS still survive from the existing entry, since there is
 *     no per-run way to pass new param values through `init`'s flags today; only `enabled`
 *     is something this run actually decided.
 *
 * A gate absent from `existingGates` always gets a freshly computed value regardless of
 * mode. `mergeConfig` still does the key-by-key merge against the rest of the file
 * (unrelated top-level keys, gates the new registry dropped).
 */
export function materializeGates(
  registry,
  enabledMap,
  existingGates = {},
  mode = MODES.DEFAULTS,
) {
  const gates = {};
  for (const gate of allGates(registry)) {
    const hasExisting = Object.prototype.hasOwnProperty.call(
      existingGates,
      gate.configKey,
    );

    if (hasExisting && mode === MODES.DEFAULTS) {
      gates[gate.configKey] = existingGates[gate.configKey];
      continue;
    }

    const enabled = enabledMap[gate.configKey] === true;
    const hasParameters = Array.isArray(gate.params) && gate.params.length > 0;
    if (!hasParameters) {
      gates[gate.configKey] = enabled;
      continue;
    }

    const defaults = defaultParametersOf(gate);
    const parameters = hasExisting
      ? { ...defaults, ...existingParametersOf(existingGates[gate.configKey]) }
      : defaults;
    gates[gate.configKey] = { enabled, ...parameters };
  }
  return gates;
}
