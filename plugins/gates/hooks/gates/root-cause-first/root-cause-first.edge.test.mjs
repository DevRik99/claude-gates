import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLE = { config: { gates: { requireRootCauseBeforePatch: true } } };

test('patch-marker comment via NotebookEdit is denied', () => {
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: 'nb.ipynb',
      cell_id: 'x',
      new_source: '// TODO fix later patch',
      cell_type: 'code',
    },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, ENABLE)));
});

test('patch-marker via replace_file_content (new_content field) is denied', () => {
  const payload = {
    tool_name: 'replace_file_content',
    tool_input: { file_path: 'x.js', new_content: '// TODO fix later patch' },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload, ENABLE)));
});
