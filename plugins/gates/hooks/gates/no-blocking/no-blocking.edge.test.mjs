// Edge-case audit for no-blocking: bypasses and false positives.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'no-blocking-edge-'));
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

const ENABLED = { gates: { blockWaitingCommands: true } };

function bash(command, extra = {}) {
  return { tool_name: 'Bash', tool_input: { command, ...extra } };
}
function mcpTool(name, input) {
  return { tool_name: name, tool_input: input };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

// ── BUG: MCP shell-equivalent tools are not in TOOL_GROUPS.shell/delegation.
test('FIXED: an mcp shell-equivalent tool running "sleep 30" is now recognized', () => {
  const result = runGate(mcpTool('mcp__shell__run', { command: 'sleep 30' }), {
    config: ENABLED,
  });
  assert.ok(isDeny(result)); // toolInGroups classifies mcp__shell__run into the shell group
});

// ── BUG (false positive / evasion pairing): the WAIT-JUSTIFIED marker escape requires
// NO reason validation beyond "two more tokens exist after the marker" — the reason text
// itself is never checked for plausibility, so trivially defeats the intent of a
// "declared, justified wait": any two words work as an unchecked excuse.
test('BUG (weak justification check): any two-word text after the marker escapes the block regardless of content', () => {
  const result = runGate(
    bash('sleep 9999 # WAIT-JUSTIFIED: because yes'),
    { config: ENABLED },
  );
  assert.equal(result, null); // allowed: marker escape has no semantic validation, only shape
});

// ── BUG candidate: `timeout 30 someserver` is matched by the sleep|timeout pattern
// requiring the command to START the line or follow |;&/then/do. A background-launched
// dev server that is piped through `| cat` first, e.g. `npm run dev | cat`, should still
// match \b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b since that's a
// substring test with no anchoring requirement (unlike sleep/timeout). Confirm no bypass.
test('OK: piping a dev server through another command does not bypass the dev-server pattern', () => {
  assert.ok(
    isDeny(runGate(bash('npm run dev | cat'), { config: ENABLED })),
  );
});

// ── BUG: `NOT_TAKING_THE_TURN` includes `-d\b` as a generic "detached" flag marker. This
// is dangerously broad: ANY command containing a standalone `-d` token — including one
// completely unrelated to backgrounding — escapes every blocking pattern. E.g. `sleep 30
// -d` (nonsensical flag for sleep, but matches) or more realistically a docker/curl
// command with an unrelated `-d` (data) flag combined with a blocking pattern.
test('FIXED: an unrelated "-d" flag (curl -d) no longer escapes the blocking check', () => {
  // curl -d is "data", not detach. The bare -d escape was removed, so a genuinely foreground
  // sleep on the same command line is now denied despite the unrelated -d flag.
  const result = runGate(bash('sleep 30; curl -d "payload" http://x'), {
    config: ENABLED,
  });
  assert.ok(isDeny(result));
});

// ── BUG candidate: `npm run dev &` (trailing background operator with a space before
// EOL, e.g. training whitespace) — NOT_TAKING_THE_TURN requires `&\s*$`. A trailing
// newline in the JSON string (unlikely from a real shell, but a delegation prompt or a
// tool that appends '\n') would still satisfy `\s*$` since \s includes \n. Not pursued
// further as a distinct bug; documenting as checked.
test('OK: trailing background operator followed by trailing whitespace still escapes correctly (not a bug)', () => {
  assert.equal(
    runGate(bash('npm run dev &  '), { config: ENABLED }),
    null,
  );
});

// ── BUG candidate: PowerShell `Start-Job` / `Start-Process ... -NoNewWindow` background
// forms are not recognized by NOT_TAKING_THE_TURN, but that only matters if the command
// is ALSO caught by a blocking pattern in the first place. `Start-Sleep` alone, run as
// `Start-Job { Start-Sleep 30 }` (already backgrounded via Start-Job) is still matched by
// \bStart-Sleep\b and NOT recognized as non-blocking, causing a FALSE POSITIVE: a
// genuinely backgrounded PowerShell job gets denied because its "backgrounded" wrapper
// (Start-Job) is not in NOT_TAKING_THE_TURN.
test('FIXED: Start-Sleep inside a Start-Job background wrapper is now allowed', () => {
  const result = runGate(bash('Start-Job { Start-Sleep 30 }'), {
    config: ENABLED,
  });
  assert.equal(result, null); // Start-Job is now recognized as a backgrounding mechanism
});
