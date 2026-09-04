import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isWarn, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Assertions updated with the audited behavior: the value on disk is the baseline, so each
// case seeds the notebook/file with the previous value.
test('NotebookEdit changing a timeout value is detected', () => {
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: 'notebook.ipynb',
      cell_id: 'abc',
      new_source: 'REQUEST_TIMEOUT_MS = 60000',
      cell_type: 'code',
    },
  };
  const files = {
    'notebook.ipynb': JSON.stringify({
      cells: [{ source: ['REQUEST_TIMEOUT_MS = 30000'] }],
    }),
  };
  assert.ok(isWarn(runGateProcess(GATE, payload, { files })));
});

test('replace_file_content changing a timeout value is detected', () => {
  const payload = {
    tool_name: 'replace_file_content',
    tool_input: {
      file_path: 'src/config.js',
      content: 'const REQUEST_TIMEOUT_MS = 60000;',
    },
  };
  const files = { 'src/config.js': 'const REQUEST_TIMEOUT_MS = 30000;' };
  assert.ok(isWarn(runGateProcess(GATE, payload, { files })));
});

test('matched content produces warn, never deny', () => {
  const result = runGateProcess(
    GATE,
    {
      tool_name: 'Write',
      tool_input: {
        file_path: 'src/config.js',
        content: 'const REQUEST_TIMEOUT_MS = 60000;',
      },
    },
    { files: { 'src/config.js': 'const REQUEST_TIMEOUT_MS = 30000;' } },
  );
  assert.ok(isWarn(result));
  assert.notEqual(result?.hookSpecificOutput?.permissionDecision, 'deny');
});
