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
  const declaredScripts = new Set(preToolUseGates.map((gate) => gate.script));
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
