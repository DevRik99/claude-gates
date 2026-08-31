import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'root-cause-first-edge-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
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

const ENABLE = { config: { gates: { requireRootCauseBeforePatch: true } } };

// FIXED: writtenContentOf reads NotebookEdit's new_source, so a deferral marker written via
// NotebookEdit is now caught by this DENY gate.
test('FIXED: patch-marker comment via NotebookEdit is now denied', () => {
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: '/repo/nb.ipynb',
      cell_id: 'x',
      new_source: '// TODO fix later patch',
      cell_type: 'code',
    },
  };
  assert.ok(
    isDeny(runGate(payload, ENABLE)),
    'a patch marker via NotebookEdit must now be denied',
  );
});

// FIXED: writtenContentOf reads replace_file_content's new_content field too.
test('FIXED: patch-marker via replace_file_content (new_content field) is now denied', () => {
  const payload = {
    tool_name: 'replace_file_content',
    tool_input: {
      file_path: '/repo/x.js',
      new_content: '// TODO fix later patch',
    },
  };
  assert.ok(
    isDeny(runGate(payload, ENABLE)),
    'the field-name variant must now be denied',
  );
});
