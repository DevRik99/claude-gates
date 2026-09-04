// Edge cases for sdd-specs: Edit payloads, malformed catalog JSON (fail closed), and a
// catalog living next to the written file rather than at the project root.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  edit,
  isDeny,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const CATALOG = join('.ai', 'feature_list.json');
const EMPTY_CATALOG = JSON.stringify({ features: [] });
const SPEC_READY = JSON.stringify({
  features: [{ name: 'checkout', status: 'spec_ready' }],
});
const ENABLED = { gates: { requireSpecBeforeImplementing: true } };

function runGate(project, payload) {
  return runGateProcess(GATE, payload, { project });
}

test('FIXED: an Edit (new_string) moving a feature to spec_ready with no contract is now detected', () => {
  const project = makeProject({
    config: ENABLED,
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  assert.ok(
    isDeny(runGate(project, edit(join(project, CATALOG), SPEC_READY, 'x'))),
  );
});

test('FIXED: malformed/invalid JSON content on a catalog write now denies (fail-closed)', () => {
  const project = makeProject({
    config: ENABLED,
    files: {
      [CATALOG]: EMPTY_CATALOG,
      [join('.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  const payload = write(
    join(project, CATALOG),
    '{features: [{name: "checkout", status: "spec_ready"}]}',
  );
  assert.ok(isDeny(runGate(project, payload)));
});

test('FIXED: a catalog living outside process.cwd() is now found via the written path', () => {
  const project = makeProject({
    config: ENABLED,
    files: {
      [join('sub', '.ai', 'feature_list.json')]: SPEC_READY,
      [join('sub', '.ai', 'features', 'checkout', '.keep')]: '',
    },
  });
  const payload = write(
    join(project, 'sub', '.ai', 'feature_list.json'),
    SPEC_READY,
  );
  assert.ok(isDeny(runGate(project, payload)));
});

test('OK: the equivalent Write-tool payload at the project root IS caught (control)', () => {
  const project = makeProject({
    config: ENABLED,
    files: { [CATALOG]: EMPTY_CATALOG },
  });
  assert.ok(
    isDeny(runGate(project, write(join(project, CATALOG), SPEC_READY))),
  );
});
