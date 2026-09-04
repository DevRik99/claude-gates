// Edge cases for bash-commands: shapes that must not evade the rules, and shapes that must
// not trip them.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bash, isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

function mcpTool(name, input) {
  return { tool_name: name, tool_input: input };
}

test('BUG: mcp filesystem write tool carrying a destructive shell command is not recognized', () => {
  // A write tool is not a shell: the content is never executed by this call.
  const result = runGate(
    mcpTool('mcp__filesystem__write_file', {
      path: '/repo/run.sh',
      content: 'git reset --hard HEAD~3',
    }),
  );
  assert.equal(result, null);
});

test('FIXED: a run_command-shaped MCP tool with a different name is now recognized', () => {
  const result = runGate(mcpTool('mcp__shell__run', { command: 'rm -rf src' }));
  assert.ok(isDeny(result));
});

test('OK: chained destructive command after && is still caught (no anchor bug here)', () => {
  assert.ok(isDeny(runGate(bash('echo hi && git reset --hard'))));
  assert.ok(isDeny(runGate(bash('echo hi ; rm -rf src'))));
});

test('OK: destructive command inside a subshell is still caught', () => {
  assert.ok(isDeny(runGate(bash('echo $(git push origin main --force)'))));
  assert.ok(isDeny(runGate(bash('echo `rm -rf src`'))));
});

test('OK: destructive command wrapped in sh -c is still caught (raw command string has no quote-stripping for shell tools)', () => {
  assert.ok(isDeny(runGate(bash('sh -c "git push origin main --force"'))));
  assert.ok(isDeny(runGate(bash("bash -lc 'rm -rf src'"))));
});

test('FIXED: rm -rf with a leading ./ on a protected area is now caught', () => {
  assert.ok(isDeny(runGate(bash('rm -rf ./src'))));
});

test('BUG: rm -rf with a trailing slash on a protected area bypasses the rm-rf pattern', () => {
  // Kept name for history: the trailing slash is normalized away, so this is denied.
  assert.ok(isDeny(runGate(bash('rm -rf src/'))));
});

test('FIXED: PowerShell Stop-Process -Name (kill by name) is now denied', () => {
  assert.ok(isDeny(runGate(bash('Stop-Process -Name node -Force'))));
});

test('OK: taskkill flag order does not evade the kill-by-name pattern', () => {
  assert.ok(isDeny(runGate(bash('taskkill /IM node.exe /F'))));
});

test('a variable-built rm target is not resolved and passes', () => {
  assert.equal(runGate(bash('rm -rf $BUILD_DIR')), null);
});
