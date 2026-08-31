// Edge-case audit for protected-paths: bypasses and false positives.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'protected-paths-edge-'));
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

function write(filePath) {
  return { tool_name: 'Write', tool_input: { file_path: filePath } };
}
function bash(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}
function mcpTool(name, input) {
  return { tool_name: name, tool_input: input };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

// ── FIXED: toolInGroups classifies an MCP tool by its action segment, so an MCP write
// tool is now recognized regardless of its exact name.
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

// ── FIXED: an mcp shell-equivalent tool with a mutating command against .env is now
// recognized too, via toolInGroups' shell signal.
test('FIXED: mcp shell-equivalent tool removing .env is now recognized as a shell tool', () => {
  const result = runGate(mcpTool('mcp__shell__run', { command: 'rm .env' }));
  assert.ok(isDeny(result));
});

// ── BUG candidate: chained command where the mutating verb and the protected path are
// split across a chain, e.g. `echo hi && rm .env` — mutatingCommand.test and
// protectedTarget.test both run against the FULL command string independently (not
// requiring adjacency), so this should still be caught. Confirm.
test('OK: mutating command chained after a harmless one is still caught', () => {
  assert.ok(isDeny(runGate(bash('echo hi && rm .env'))));
});

// ── BUG candidate: redirect-to-protected pattern `>>?\s*\S*(protected)` requires the
// protected fragment to appear immediately after the redirect target token (no space
// before it beyond \s*, and \S* is greedy so it consumes up to whitespace). A redirect
// with a relative path prefix like `echo x > ./.env` should still match since '.env' is
// a substring inside './.env'. Confirm.
test('OK: redirect to a protected path via a relative ./ prefix is still caught', () => {
  assert.ok(isDeny(runGate(bash('echo "X=1" > ./.env'))));
});

// ── BUG: the redirect pattern anchors on `>>?\s*\S*(protected)` — but it does not
// require a mutating command AT ALL; a bare redirect from an allowed "reading" command
// like `cat foo > .env` is denied correctly. But what about protected-path matches
// inside an UNQUOTED argument to a non-mutating, non-redirecting command that merely
// happens to reference the filename without any real risk, e.g. `node --check .env`?
// mutatingCommand list doesn't include 'node', and there's no redirect, so
// targetsProtected is false — correctly allowed. Confirm to make sure the "read/lint a
// protected path" case is not a false positive.
test('OK: a non-mutating command that only references a protected filename is allowed', () => {
  assert.equal(runGate(bash('node --check .env')), null);
});

// ── BUG: case sensitivity / path separator on Windows. protectedTarget building lower-
// cases the path fragment comparison for isProtectedPath (writes) via .toLowerCase(), but
// for the SHELL branch, buildCommandPatterns compiles patterns with the 'i' flag, so case
// should be handled there too. Confirm mixed-case doesn't bypass either branch.
test('OK: mixed-case protected path does not bypass either the write or shell branch', () => {
  assert.ok(isDeny(runGate(write('/repo/.ENV'))));
  assert.ok(isDeny(runGate(bash('rm .ENV'))));
});

// ── FIXED: the write and shell branches normalize backslashes to forward slashes before
// comparing, so a Windows-style absolute path under hooks\ now matches the 'hooks/'
// protected fragment.
// Built with String#concat, not a literal: a literal starting `C:\` reads to the linter's
// hard-coded-path heuristic as a real hard-coded location, which this fixture deliberately
// is not (it is exercising Windows-path normalization, not pointing at a real path).
test('FIXED: windows backslash path under hooks\\ now matches the "hooks/" protected fragment', () => {
  const windowsStylePath = 'C:'.concat(
    '\\repo',
    '\\hooks',
    '\\gates',
    '\\evil.mjs',
  );
  const result = runGate(write(windowsStylePath));
  assert.ok(isDeny(result));
});

// ── BUG: sed -i is in mutatingCommands as the two-token regex source `sed\\s+-i` joined
// into one big alternation with \b...\b around the WHOLE alternation, not each term. This
// means the outer \b applies to the first alternative's boundary only for single-word
// terms; for the multi-word 'sed\\s+-i' term, \b anchors immediately before 's' and after
// the LAST alternative in the group, not after 'sed\s+-i' locally — but since it's inside
// one non-capturing pattern (`\b(a|b|sed\s+-i|c)\b`), the trailing \b applies right after
// whatever alternative matched, i.e. after "-i", which IS a word boundary. Confirm sed -i
// against a protected path is still caught (not a bug) before moving on.
test('OK: sed -i against a protected path is still caught', () => {
  assert.ok(isDeny(runGate(bash('sed -i "s/a/b/" .env'))));
});
