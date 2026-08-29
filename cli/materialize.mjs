// Materializes each gate's default params into the config that `init` writes, so every
// configurable value (a whitelist, a pattern list, a threshold) lands in the user's
// .ai/config.json ready to edit. The values come from the gates themselves — each gate,
// run with CLAUDE_GATES_DUMP_DEFAULTS set, prints its own defaults — so there is a single
// source of truth (the gate) and nothing is duplicated in the registry.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { REPOSITORY_ROOT } from './constants.mjs';
import { allGates } from './registry.mjs';

const DUMP_ENV = 'CLAUDE_GATES_DUMP_DEFAULTS';
const PLUGIN_HOOKS_DIR = join(REPOSITORY_ROOT, 'plugins', 'gates', 'hooks');

/**
 * Runs one gate in defaults-dump mode and returns its built-in params. The registry only
 * lists gates that exist on disk (enforced by a test), so this always resolves; a genuine
 * runtime failure yields {} rather than aborting the whole init.
 */
function defaultParametersOf(gate) {
  try {
    const out = execFileSync(
      process.execPath,
      [join(PLUGIN_HOOKS_DIR, gate.script)],
      { encoding: 'utf8', env: { ...process.env, [DUMP_ENV]: '1' } },
    );
    return JSON.parse(out).defaultParams ?? {};
  } catch {
    return {};
  }
}

/**
 * Turns the flat `{ configKey: enabled }` selection into the config's gates map. A gate
 * that declares params (per the registry) becomes `{ enabled, ...defaults }` so its knobs
 * are visible and editable; a gate with no params stays a plain boolean, keeping the file
 * compact. Only gates with params are spawned, so paramless selections cost nothing.
 */
export function materializeGates(registry, enabledMap) {
  const gates = {};
  for (const gate of allGates(registry)) {
    const enabled = enabledMap[gate.configKey] === true;
    const hasParameters = Array.isArray(gate.params) && gate.params.length > 0;
    if (!hasParameters) {
      gates[gate.configKey] = enabled;
      continue;
    }
    gates[gate.configKey] = { enabled, ...defaultParametersOf(gate) };
  }
  return gates;
}
