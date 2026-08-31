// The smoke manifest must cover every PreToolUse gate — a new gate added without a fixture
// would silently escape the behavioral smoke test. This fails when the two drift apart.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRegistry, allGates } from '../registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(join(HERE, '..', 'smoke-fixtures.json'), 'utf8'),
).fixtures;

test('every PreToolUse gate has a smoke fixture', () => {
  const preToolUseIds = allGates(loadRegistry())
    .filter((gate) => gate.event === 'PreToolUse')
    .map((gate) => gate.id);
  const covered = new Set(FIXTURES.map((fixture) => fixture.id));
  const missing = preToolUseIds.filter((id) => !covered.has(id));
  assert.deepEqual(
    missing,
    [],
    `PreToolUse gate(s) with no smoke fixture: ${missing.join(', ')}`,
  );
});

test('every fixture maps to a real gate and declares a valid type', () => {
  const gateIds = new Set(allGates(loadRegistry()).map((gate) => gate.id));
  for (const fixture of FIXTURES) {
    assert.ok(
      gateIds.has(fixture.id),
      `fixture "${fixture.id}" does not match any gate in the registry`,
    );
    assert.ok(
      ['deny', 'warn', 'none'].includes(fixture.type),
      `fixture "${fixture.id}" has invalid type "${fixture.type}"`,
    );
    // A non-skipped, reacting fixture must carry a payload to plant.
    if (!fixture.needsState && fixture.type !== 'none') {
      assert.ok(
        fixture.payload && typeof fixture.payload === 'object',
        `fixture "${fixture.id}" reacts but has no payload`,
      );
    }
  }
});
