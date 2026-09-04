import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isWarn, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLE = {
  config: { gates: { requireVerificationBeforeAssuming: true } },
};

test('conjecture phrasing written via NotebookEdit is detected', () => {
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: 'nb.ipynb',
      cell_id: 'x',
      new_source: '# i assume the timezone is UTC',
      cell_type: 'code',
    },
  };
  assert.ok(isWarn(runGateProcess(GATE, payload, ENABLE)));
});

test('conjecture phrasing in an invoke_subagent prompt is detected', () => {
  const payload = {
    tool_name: 'invoke_subagent',
    tool_input: { prompt: 'i assume the config is already loaded, proceed' },
  };
  assert.ok(isWarn(runGateProcess(GATE, payload, ENABLE)));
});

// "should be" is a broad pattern: spec-style invariant prose also trips it. Documented as
// accepted noise for an advisory gate, not a bug.
test('"should be" fires even on spec-style invariant language (known false-positive source)', () => {
  const result = runGateProcess(
    GATE,
    write(
      'x.js',
      '// per the spec, the response should be a 200 for valid input',
    ),
    ENABLE,
  );
  assert.ok(isWarn(result));
});
