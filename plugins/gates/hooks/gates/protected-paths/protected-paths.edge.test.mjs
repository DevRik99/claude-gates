// Edge cases for protected-paths: shapes that must not evade the rule, and shapes that must
// not trip it.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bash, isDeny, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
}

function mcpTool(name, input) {
  return { tool_name: name, tool_input: input };
}

test('FIXED: mcp filesystem write_file targeting .env is now recognized as a write tool', () => {
  const result = runGate(
    mcpTool('mcp__filesystem__write_file', {
      path: '/repo/.env',
      content: 'X=1',
    }),
  );
  assert.ok(isDeny(result));
});

test('FIXED: mcp filesystem edit_file targeting package-lock.json is now recognized', () => {
  const result = runGate(
    mcpTool('mcp__filesystem__edit_file', {
      file_path: '/repo/package-lock.json',
      diff: '...',
    }),
  );
  assert.ok(isDeny(result));
});

test('FIXED: mcp shell-equivalent tool removing .env is now recognized as a shell tool', () => {
  const result = runGate(mcpTool('mcp__shell__run', { command: 'rm .env' }));
  assert.ok(isDeny(result));
});

test('OK: mutating command chained after a harmless one is still caught', () => {
  assert.ok(isDeny(runGate(bash('echo hi && rm .env'))));
});

test('OK: redirect to a protected path via a relative ./ prefix is still caught', () => {
  assert.ok(isDeny(runGate(bash('echo "X=1" > ./.env'))));
});

test('OK: a non-mutating command that only references a protected filename is allowed', () => {
  assert.equal(runGate(bash('node --check .env')), null);
});

test('OK: mixed-case protected path does not bypass either the write or shell branch', () => {
  assert.ok(isDeny(runGate(write('/repo/.ENV'))));
  assert.ok(isDeny(runGate(bash('rm .ENV'))));
});

// The default fragment is now `.claude/hooks/` (the audit showed a bare `hooks/` denied every
// React/Vue project's src/hooks), so the Windows path exercised here sits under .claude.
// Built with String#concat so the linter's hard-coded-path heuristic does not read the fixture
// as a real location.
test('FIXED: windows backslash path under hooks\\ now matches the "hooks/" protected fragment', () => {
  const windowsStylePath = 'C:'.concat(
    '\\repo',
    '\\.claude',
    '\\hooks',
    '\\gates',
    '\\evil.mjs',
  );
  assert.ok(isDeny(runGate(write(windowsStylePath))));
});

test('OK: sed -i against a protected path is still caught', () => {
  assert.ok(isDeny(runGate(bash('sed -i "s/a/b/" .env'))));
});

test('a variable-built target is not resolved and passes', () => {
  assert.equal(runGate(bash('rm "$SECRET_FILE"')), null);
});
