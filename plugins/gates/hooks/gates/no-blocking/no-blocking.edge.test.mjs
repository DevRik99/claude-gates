// Edge cases for no-blocking: bypasses and false positives.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bash, isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLED = { gates: { blockWaitingCommands: true } };

function runGate(payload) {
  return runGateProcess(GATE, payload, { config: ENABLED });
}

function mcpTool(name, input) {
  return { tool_name: name, tool_input: input };
}

test('FIXED: an mcp shell-equivalent tool running "sleep 30" is now recognized', () => {
  assert.ok(
    isDeny(runGate(mcpTool('mcp__shell__run', { command: 'sleep 30' }))),
  );
});

test('BUG (weak justification check): any two-word text after the marker escapes the block regardless of content', () => {
  // The marker is a declaration, not a validated excuse: the shape is all a hook can check.
  assert.equal(runGate(bash('sleep 9999 # WAIT-JUSTIFIED: because yes')), null);
});

test('OK: piping a dev server through another command does not bypass the dev-server pattern', () => {
  assert.ok(isDeny(runGate(bash('npm run dev | cat'))));
});

test('FIXED: an unrelated "-d" flag (curl -d) no longer escapes the blocking check', () => {
  assert.ok(isDeny(runGate(bash('sleep 30; curl -d "payload" http://x'))));
});

test('OK: trailing background operator followed by trailing whitespace still escapes correctly (not a bug)', () => {
  assert.equal(runGate(bash('npm run dev &  ')), null);
});

test('FIXED: Start-Sleep inside a Start-Job background wrapper is now allowed', () => {
  assert.equal(runGate(bash('Start-Job { Start-Sleep 30 }')), null);
});

test('a 2>&1 redirection is not a background operator', () => {
  assert.ok(isDeny(runGate(bash('sleep 30 2>&1'))));
});
