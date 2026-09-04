// Edge cases for feature-catalog: an Edit (new_string) is read through writtenContentOf and
// judged like a Write.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { edit, isDeny, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const CATALOG = 'feature_list.json';

function runGate(payload) {
  return runGateProcess(GATE, payload);
}

test('FIXED: an Edit (new_string) writing status:done to the catalog is now detected', () => {
  const payload = edit(
    CATALOG,
    JSON.stringify({ features: [{ name: 'checkout', status: 'done' }] }),
    'x',
  );
  assert.ok(isDeny(runGate(payload)));
});

test('FIXED: an Edit (new_string) exceeding maxInProgress is now detected', () => {
  const payload = edit(
    CATALOG,
    JSON.stringify({
      features: [
        { name: 'a', status: 'in_progress' },
        { name: 'b', status: 'in_progress' },
      ],
    }),
    'x',
  );
  assert.ok(isDeny(runGate(payload)));
});

test('OK: the equivalent Write-tool payload IS caught (control)', () => {
  const payload = write(
    CATALOG,
    JSON.stringify({ features: [{ name: 'checkout', status: 'done' }] }),
  );
  assert.ok(isDeny(runGate(payload)));
});
