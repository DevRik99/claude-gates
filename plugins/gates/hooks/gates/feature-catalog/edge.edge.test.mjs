// Edge-case probes for feature-catalog. Previously an Edit (new_string) writing
// status:done or an in_progress overrun to the catalog bypassed this gate because
// writeContentFrom() read only CodeContent/ReplacementContent/content, never
// new_string. Migrated to writtenContentOf()/writtenPathOf() (hook-io.mjs), which read
// through every known field shape, so these are now caught the same as a Write.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload) {
  const project = mkdtempSync(join(tmpdir(), 'feature-catalog-edge-'));
  mkdirSync(join(project, '.git'));
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('FIXED: an Edit (new_string) writing status:done to the catalog is now detected', () => {
  const payload = {
    tool_name: 'Edit',
    tool_input: {
      file_path: 'feature_list.json',
      old_string: 'x',
      new_string: JSON.stringify({
        features: [{ name: 'checkout', status: 'done' }],
      }),
    },
  };
  assert.ok(
    isDeny(runGate(payload)),
    'writtenContentOf reads new_string and catches status:done via Edit',
  );
});

test('FIXED: an Edit (new_string) exceeding maxInProgress is now detected', () => {
  const payload = {
    tool_name: 'Edit',
    tool_input: {
      file_path: 'feature_list.json',
      old_string: 'x',
      new_string: JSON.stringify({
        features: [
          { name: 'a', status: 'in_progress' },
          { name: 'b', status: 'in_progress' },
        ],
      }),
    },
  };
  assert.ok(
    isDeny(runGate(payload)),
    'writtenContentOf reads new_string and catches the maxInProgress overrun via Edit',
  );
});

test('OK: the equivalent Write-tool payload IS caught (control)', () => {
  const payload = {
    tool_name: 'Write',
    tool_input: {
      file_path: 'feature_list.json',
      content: JSON.stringify({
        features: [{ name: 'checkout', status: 'done' }],
      }),
    },
  };
  assert.ok(
    isDeny(runGate(payload)),
    'control failed: Write-tool status:done should be denied',
  );
});
