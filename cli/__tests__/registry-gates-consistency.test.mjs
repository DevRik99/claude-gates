// The registry and the gates on disk must agree: every PreToolUse gate the registry
// declares has to have a script, and every gate folder on disk has to be declared. A
// mismatch (a registry entry with no file, like the old `autocommit`, or an orphan folder)
// is what made `init` spawn a non-existent gate — this test blocks it from returning.

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRegistry, allGates } from '../registry.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATES_DIR = join(REPO, 'plugins', 'gates', 'hooks', 'gates');

const registry = loadRegistry();
const preToolUseGates = allGates(registry).filter(
  (gate) => gate.event === 'PreToolUse',
);
// Gates that live one-per-folder under plugins/gates/hooks/gates/ — regardless of which
// event they hook (most are PreToolUse, but e.g. stop-pending is Stop). Session-scoped
// hooks (doctor.mjs, ask-adoption.mjs, ...) are top-level scripts outside this folder and
// are intentionally excluded, matching the `gates/x.mjs` vs `x.mjs` convention documented
// in registry.mjs's SCRIPT_PATTERN.
const folderGates = allGates(registry).filter((gate) =>
  gate.script.startsWith('gates/'),
);

test('every PreToolUse gate in the registry has its script on disk', () => {
  for (const gate of preToolUseGates) {
    const scriptPath = join(REPO, 'plugins', 'gates', 'hooks', gate.script);
    assert.ok(
      existsSync(scriptPath),
      `registry declares gate "${gate.id}" (script ${gate.script}) but the file is missing`,
    );
  }
});

test('every gate folder on disk is declared in the registry', () => {
  const declaredScripts = new Set(folderGates.map((gate) => gate.script));
  const folders = readdirSync(GATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const folder of folders) {
    const expectedScript = `gates/${folder}/index.mjs`;
    assert.ok(
      declaredScripts.has(expectedScript),
      `gate folder "${folder}" exists on disk but no registry entry points to ${expectedScript}`,
    );
  }
});
