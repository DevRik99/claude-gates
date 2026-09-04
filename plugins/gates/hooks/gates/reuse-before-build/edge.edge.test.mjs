import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLED = {
  config: { gates: { requireReuseCheckBeforeBuilding: true } },
};

function runGate(payload) {
  return runGateProcess(GATE, payload, ENABLED);
}

test('a legitimate "mytools/" folder is not misclassified as a tool build', () => {
  assert.equal(
    isDeny(
      runGate(write('src/mytools/thing.mjs', 'export function thing(){}')),
    ),
    false,
  );
});

test('a real "tools/" folder is still caught (control for the segment fix)', () => {
  assert.ok(
    isDeny(runGate(write('tools/thing.mjs', 'export function thing(){}'))),
  );
});

test('an MCP-style write tool name is not invisible to the gate', () => {
  const payload = {
    tool_name: 'mcp__filesystem__write_file',
    tool_input: {
      file_path: 'scripts/new-tool.mjs',
      content: 'export function parse(){}',
    },
  };
  assert.ok(isDeny(runGate(payload)));
});

test('a delegation prompt carried in `task` (not prompt/description) is checked', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: { task: 'Please write a new script that parses CSV files.' },
  };
  assert.ok(isDeny(runGate(payload)));
});

test('the equivalent Write-tool payload IS caught (control)', () => {
  assert.ok(
    isDeny(runGate(write('scripts/new-tool.mjs', 'export function parse(){}'))),
  );
});
