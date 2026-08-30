import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'diagnosis-edge-'));
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

function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}

// FIXED: extractText() now gates on toolInGroups(toolName, ['write']) and reads through
// writtenContentOf() (lib/hook-io.mjs), which covers NotebookEdit's new_source field.
test('FIXED: NotebookEdit changing a timeout value is detected', () => {
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: '/repo/notebook.ipynb',
      cell_id: 'abc',
      new_source: 'REQUEST_TIMEOUT_MS = 30000',
      cell_type: 'code',
    },
  };
  assert.ok(isWarn(runGate(payload)), 'gate now detects a timeout change via NotebookEdit');
});

// FIXED: replace_file_content is recognized by toolInGroups(toolName, ['write']) (native
// name in TOOL_GROUPS.write) and its `content` field is read through writtenContentOf().
test('FIXED: replace_file_content changing a timeout value is detected', () => {
  const payload = {
    tool_name: 'replace_file_content',
    tool_input: {
      file_path: '/repo/src/config.js',
      content: 'const REQUEST_TIMEOUT_MS = 30000;',
    },
  };
  assert.ok(isWarn(runGate(payload)), 'gate now detects a timeout change via replace_file_content');
});

// EDGE CASE: confirm severity really is warn-only, never deny, for a real match (per WARN
// family classification). This should hold given index.mjs only calls warn(), never deny.
test('OK: matched content produces warn, never deny', () => {
  const result = runGate({
    tool_name: 'Write',
    tool_input: { file_path: '/repo/src/config.js', content: 'const REQUEST_TIMEOUT_MS = 30000;' },
  });
  assert.ok(isWarn(result));
  assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
});
