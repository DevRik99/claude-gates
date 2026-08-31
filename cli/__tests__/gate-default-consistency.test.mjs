// Each gate carries its own default enabled-state as a literal in its source — either
// `enabledByDefault: <bool>` in the runGate descriptor, or the second argument to
// `isGateEnabled(CONFIG_KEY, <bool>, cwd)` for gates (Stop hooks) that call it directly.
// The gate does NOT read registry.json at runtime, so that literal IS the default when a
// project's config is silent about the key. It must equal the gate's `default` in
// registry.json — otherwise the catalog says one thing and the installed hook does another.
//
// This test exists because stop-pending shipped with `isGateEnabled(KEY, false, ...)` while
// the registry declared `default: true`: on a fresh install the pending-task reminder never
// fired, because the hardcoded false won. The unit test masked it by enabling the gate
// explicitly. This check plants that class of defect and fails on it.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRegistry, allGates } from '../registry.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATES_DIR = join(REPO, 'plugins', 'gates', 'hooks', 'gates');

const registry = loadRegistry();
const registryDefaultByConfigKey = new Map(
  allGates(registry).map((gate) => [gate.configKey, gate.default]),
);

/** The default enabled-state a gate's source hardcodes, or null when it declares none. */
function sourceDefaultOf(source) {
  const descriptor = source.match(/enabledByDefault:\s*(true|false)/);
  if (descriptor) return descriptor[1] === 'true';
  const directCall = source.match(/isGateEnabled\([^,]+,\s*(true|false)/);
  if (directCall) return directCall[1] === 'true';
  return null;
}

function configKeyOf(source) {
  const match = source.match(/CONFIG_KEY\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

test("each gate's hardcoded default matches its registry `default`", () => {
  const folders = readdirSync(GATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const mismatches = [];
  for (const folder of folders) {
    let source;
    try {
      source = readFileSync(join(GATES_DIR, folder, 'index.mjs'), 'utf8');
    } catch {
      continue; // no index.mjs in this folder
    }
    const sourceDefault = sourceDefaultOf(source);
    if (sourceDefault === null) continue; // gate declares no literal default; nothing to check

    const configKey = configKeyOf(source);
    assert.ok(
      configKey,
      `${folder}: found a default literal but no CONFIG_KEY to map it to the registry`,
    );
    assert.ok(
      registryDefaultByConfigKey.has(configKey),
      `${folder}: configKey "${configKey}" is not declared in registry.json`,
    );

    const registryDefault = registryDefaultByConfigKey.get(configKey);
    if (sourceDefault !== registryDefault) {
      mismatches.push(
        `${folder}: source default=${sourceDefault} but registry default=${registryDefault} (configKey ${configKey})`,
      );
    }
  }

  assert.deepEqual(
    mismatches,
    [],
    `Gate default(s) out of sync with registry.json:\n${mismatches.join('\n')}`,
  );
});
