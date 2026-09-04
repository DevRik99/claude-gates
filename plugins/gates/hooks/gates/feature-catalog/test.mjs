import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  edit,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const CATALOG = 'feature_list.json';

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

function catalog(...features) {
  return JSON.stringify({ features });
}

test('denies writing status:done directly to the catalog', () => {
  const content = catalog({ name: 'checkout', status: 'done' });
  assert.ok(isDeny(runGate(write(CATALOG, content))));
});

test('denies more than maxInProgress features in_progress', () => {
  const content = catalog(
    { name: 'a', status: 'in_progress' },
    { name: 'b', status: 'in_progress' },
  );
  assert.ok(isDeny(runGate(write(CATALOG, content))));
});

test('allows a write with one in_progress feature and no direct done', () => {
  const content = catalog(
    { name: 'a', status: 'in_progress' },
    { name: 'b', status: 'spec_ready' },
  );
  assert.equal(runGate(write(CATALOG, content)), null);
});

test('allows a write to an unrelated file (auto-off: no catalog targeted)', () => {
  const content = JSON.stringify({ status: 'done' });
  assert.equal(runGate(write('notes.json', content)), null);
});

test('disabled by config: the gate does not run', () => {
  const content = catalog({ name: 'checkout', status: 'done' });
  assert.equal(
    runGate(write(CATALOG, content), {
      config: { gates: { requireFeatureCatalog: false } },
    }),
    null,
  );
});

test('project param maxInProgress override raises/lowers the threshold', () => {
  const content = catalog(
    { name: 'a', status: 'in_progress' },
    { name: 'b', status: 'in_progress' },
  );
  const config = {
    gates: { requireFeatureCatalog: { enabled: true, maxInProgress: 2 } },
  };
  assert.equal(runGate(write(CATALOG, content), { config }), null);
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('a feature that is already done on disk stays writable: only a NEW done transition is denied', () => {
  const project = makeProject({
    files: {
      [join('.ai', CATALOG)]: catalog(
        { name: 'checkout', status: 'done' },
        { name: 'cart', status: 'todo' },
      ),
    },
  });
  const unchanged = catalog(
    { name: 'checkout', status: 'done' },
    { name: 'cart', status: 'in_progress' },
  );
  assert.equal(
    runGate(write(join('.ai', CATALOG), unchanged), { project }),
    null,
  );

  const closesCart = catalog(
    { name: 'checkout', status: 'done' },
    { name: 'cart', status: 'done' },
  );
  const result = runGate(write(join(project, '.ai', CATALOG), closesCart), {
    project,
  });
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /moves cart to 'status: done'/);
});

test('an Edit is applied to the disk content, so the in_progress count covers the whole file', () => {
  const project = makeProject({
    files: {
      [join('.ai', CATALOG)]: catalog(
        { name: 'a', status: 'in_progress' },
        { name: 'b', status: 'todo' },
      ),
    },
  });
  const payload = edit(
    join(project, '.ai', CATALOG),
    '{"name":"b","status":"in_progress"}',
    '{"name":"b","status":"todo"}',
  );
  const result = runGate(payload, { project });
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /would have 2 features 'in_progress'/);
});

test('an Edit that leaves an already-done feature untouched is allowed', () => {
  const project = makeProject({
    files: {
      [join('.ai', CATALOG)]: catalog(
        { name: 'checkout', status: 'done' },
        { name: 'b', status: 'todo' },
      ),
    },
  });
  const payload = edit(
    join(project, '.ai', CATALOG),
    '"status":"in_progress"}]}',
    '"status":"todo"}]}',
  );
  assert.equal(runGate(payload, { project }), null);
});

test('an Edit whose old_string is not on disk is judged as a fragment', () => {
  const payload = edit(
    CATALOG,
    catalog({ name: 'checkout', status: 'done' }),
    'not-on-disk',
  );
  assert.ok(isDeny(runGate(payload)));
});

test('a shell redirect onto the catalog is denied', () => {
  const result = runGate(bash(`echo '{"features":[]}' > .ai/${CATALOG}`));
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /redirect\/copy\/move/);
  assert.ok(isDeny(runGate(bash(`cp backup.json .ai/${CATALOG}`))));
  assert.equal(runGate(bash('cat .ai/feature_list.json')), null);
});

test('single-quoted / YAML-style in_progress statuses are counted like JSON ones', () => {
  const fragment =
    "- name: a\n  status: 'in_progress'\n- name: b\n  status: 'in_progress'\n";
  assert.ok(isDeny(runGate(write(CATALOG, fragment))));
});

test('an empty catalogFileName turns the gate off', () => {
  const config = {
    gates: { requireFeatureCatalog: { enabled: true, catalogFileName: '' } },
  };
  assert.equal(
    runGate(write(CATALOG, catalog({ name: 'checkout', status: 'done' })), {
      config,
    }),
    null,
  );
});

test('a non-numeric maxInProgress falls back to the default of 1', () => {
  const config = {
    gates: { requireFeatureCatalog: { enabled: true, maxInProgress: 'many' } },
  };
  const content = catalog(
    { name: 'a', status: 'in_progress' },
    { name: 'b', status: 'in_progress' },
  );
  assert.ok(isDeny(runGate(write(CATALOG, content), { config })));
});
