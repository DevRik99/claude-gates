import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'feature-catalog-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function writeCatalog(content, targetFile = 'feature_list.json') {
  return {
    tool_name: 'Write',
    tool_input: { file_path: targetFile, content },
  };
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('denies writing status:done directly to the catalog', () => {
  const content = JSON.stringify({
    features: [{ name: 'checkout', status: 'done' }],
  });
  assert.ok(isDeny(runGate(writeCatalog(content))));
});

test('denies more than maxInProgress features in_progress', () => {
  const content = JSON.stringify({
    features: [
      { name: 'a', status: 'in_progress' },
      { name: 'b', status: 'in_progress' },
    ],
  });
  assert.ok(isDeny(runGate(writeCatalog(content))));
});

test('allows a write with one in_progress feature and no direct done', () => {
  const content = JSON.stringify({
    features: [
      { name: 'a', status: 'in_progress' },
      { name: 'b', status: 'spec_ready' },
    ],
  });
  assert.equal(runGate(writeCatalog(content)), null);
});

test('allows a write to an unrelated file (auto-off: no catalog targeted)', () => {
  const content = JSON.stringify({ status: 'done' });
  assert.equal(runGate(writeCatalog(content, 'notes.json')), null);
});

test('disabled by config: the gate does not run', () => {
  const content = JSON.stringify({
    features: [{ name: 'checkout', status: 'done' }],
  });
  assert.equal(
    runGate(writeCatalog(content), {
      config: { gates: { requireFeatureCatalog: false } },
    }),
    null,
  );
});

test('project param maxInProgress override raises/lowers the threshold', () => {
  const content = JSON.stringify({
    features: [
      { name: 'a', status: 'in_progress' },
      { name: 'b', status: 'in_progress' },
    ],
  });
  const config = {
    gates: {
      requireFeatureCatalog: { enabled: true, maxInProgress: 2 },
    },
  };
  assert.equal(runGate(writeCatalog(content), { config }), null);
});
