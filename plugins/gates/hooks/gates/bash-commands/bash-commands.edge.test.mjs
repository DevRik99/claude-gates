// Edge-case audit for bash-commands: bypasses (should deny but doesn't) and false
// positives (denies something innocuous). Each test documents the payload and asserts
// the ACTUAL observed behavior of the gate as it stands today — a green test here means
// the described case is a confirmed bug (bypass) unless the test name says otherwise.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'bash-commands-edge-'));
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

function bash(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}
function mcpTool(name, input) {
  return { tool_name: name, tool_input: input };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

// ── BUG: MCP write/exec tools are not in TOOL_GROUPS.shell/write/delegation, so the
// gate's own `toolName` check (SHELL_TOOLS.has / DELEGATION_TOOLS.has) never matches an
// mcp__* tool even if the gate DID receive the call. hooks.json's `matcher` also never
// includes any mcp__*__write/run pattern (only mcp__ide__executeCode, and only for
// rule-skill-autodiscovery/recurrence-lock, not this gate) so Claude Code would not even
// invoke this hook for such a tool call. This test proves the gate-level half of the bug:
// even fed the payload directly, it does not recognize the tool and allows destructive
// content that would be denied under Bash.
test('BUG: mcp filesystem write tool carrying a destructive shell command is not recognized', () => {
  const result = runGate(
    mcpTool('mcp__filesystem__write_file', {
      path: '/repo/run.sh',
      content: 'git reset --hard HEAD~3',
    }),
  );
  assert.equal(result, null); // allowed: bypass confirmed
});

test('FIXED: a run_command-shaped MCP tool with a different name is now recognized', () => {
  // e.g. an MCP server that exposes its shell tool as mcp__shell__run instead of run_command.
  // toolInGroups classifies it into the shell group by its action segment, so the destructive
  // command it carries is now inspected and denied.
  const result = runGate(mcpTool('mcp__shell__run', { command: 'rm -rf src' }));
  assert.ok(isDeny(result));
});

// ── BUG: command chaining. checkDestructive/checkRemotePublish test the WHOLE command
// string with patterns that use \b word boundaries without anchoring to start-of-command,
// so `a && git push` and `a; rm -rf src` SHOULD still match (the regex has no ^ anchor).
// Confirm this actually still catches chaining (expected: denied, i.e. NOT a bug) so we
// don't misreport it.
test('OK: chained destructive command after && is still caught (no anchor bug here)', () => {
  assert.ok(isDeny(runGate(bash('echo hi && git reset --hard'))));
  assert.ok(isDeny(runGate(bash('echo hi ; rm -rf src'))));
});

// ── BUG: subshell / command substitution. The destructive pattern is a plain substring
// regex, so it should still match text inside $(...) or backticks. Confirm.
test('OK: destructive command inside a subshell is still caught', () => {
  assert.ok(isDeny(runGate(bash('echo $(git push origin main --force)'))));
  assert.ok(isDeny(runGate(bash('echo `rm -rf src`'))));
});

// Note: env-var-prefixed `git push` and other plain remote-publish bypass cases moved to
// block-remote-publish/__tests__ along with the rule. `git push --force` stays here (it is
// destructive), covered by the subshell/sh -c force-push cases above and below.

// ── BUG: `sh -c "..."` / `bash -lc "..."` wrapping. The outer command line still
// literally contains the inner destructive text as a substring (it's quoted, not
// encoded), so the plain regex against the raw command string should still match. But the
// remote-publish description-detector's `stripQuoted` step only runs for delegation
// prompts (isShell=true skips the intent check and matches literally) — so a real Bash
// call wrapped in sh -c should NOT bypass this gate. If it did NOT bypass, that's OK, but
// worth confirming since it's tempting to assume quoting evades a regex the way it does
// in stripQuoted's quote-stripping heuristic used for delegation.
test('OK: destructive command wrapped in sh -c is still caught (raw command string has no quote-stripping for shell tools)', () => {
  assert.ok(isDeny(runGate(bash('sh -c "git push origin main --force"'))));
  assert.ok(isDeny(runGate(bash("bash -lc 'rm -rf src'"))));
});

// ── BUG: rm -rf with a relative-but-not-listed path segment prefix, e.g. `rm -rf ./src`
// or `rm -rf src/` (trailing slash) may not match `\brm\s+-rf\s+(area)\b` because of the
// `./` prefix or trailing slash changing the \b boundary expectations.
test('FIXED: rm -rf with a leading ./ on a protected area is now caught', () => {
  const result = runGate(bash('rm -rf ./src'));
  assert.ok(isDeny(result)); // the optional ./ prefix is now part of the rm -rf pattern
});

test('BUG: rm -rf with a trailing slash on a protected area bypasses the rm-rf pattern', () => {
  const result = runGate(bash('rm -rf src/'));
  // \bsrc\b: 'src/' still has a word boundary right after 'src' (before '/'), so this
  // actually still matches. Included to document the check, not assumed.
  assert.ok(isDeny(result));
});

// ── BUG: `git reset --hard` split across an alias / npx wrapper e.g.
// `npx --yes git reset --hard` (unusual but plausible in some CI wrapper) is unaffected;
// the pattern still matches the literal substring `git reset --hard` inside. Confirm no
// bypass there; the interesting bypass is quoting INSIDE an argument that a shell would
// interpret literally as separate tokens but which our regex still sees as one string —
// there is no such distinct case; skip.

// ── BUG: kill-by-name pattern only covers `taskkill ... /IM`, `pkill `, `killall `.
// `Stop-Process -Name node` (PowerShell) is a kill-by-name equivalent not in the pattern.
test('FIXED: PowerShell Stop-Process -Name (kill by name) is now denied', () => {
  const result = runGate(bash('Stop-Process -Name node -Force'));
  assert.ok(isDeny(result)); // Stop-Process -Name is now in the kill-by-name rules
});

// ── BUG: `taskkill` without the literal `/IM` flag before the process name, e.g.
// `taskkill /F /PID 1234 /IM node.exe` still has /IM later, but `taskkill /F /T /IM *`
// with wildcard, or simply reordered flags `taskkill /IM node.exe /F` — pattern requires
// `taskkill\s+[^|;]*[/]IM` which does match flags-then-/IM in any order since [^|;]* is
// greedy-any. Confirm both orders are caught (no bug) before asserting the wildcard case.
test('OK: taskkill flag order does not evade the kill-by-name pattern', () => {
  assert.ok(isDeny(runGate(bash('taskkill /IM node.exe /F'))));
});

// Note: the `command gh pr merge` wrapper case and the delegation reporting-verb bypass case
// moved to block-remote-publish/__tests__ along with the remote-publish rule.
