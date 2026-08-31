// Edge-case probes for reuse-before-build. Previously: (1) TOOL_FOLDERS matching was a
// bare substring test on the normalized path, so a legitimate folder like
// "src/mytools/thing.mjs" was misclassified as a tool build (false positive) because
// it contains the substring "tools/"; (2) checkDelegation read the prompt only from
// toolInput.prompt/description, so a delegation using another field name (e.g. `task`)
// was invisible; (3) an MCP-style write tool name (not in the old TOOL_GROUPS.write
// Set) bypassed the gate entirely. All three are now fixed: isExecutableToolPath
// compares whole path SEGMENTS (not substrings), delegationPromptOf() reads
// task/instructions/message/input too, and toolInGroups() classifies any mcp__* tool
// by its action segment so an unrecognized MCP write name is still caught.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'reuse-before-build-edge-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  const effectiveConfig = config ?? {
    gates: { requireReuseCheckBeforeBuilding: true },
  };
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify(effectiveConfig),
  );
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('FIXED: a legitimate "mytools/" folder is no longer misclassified as a tool build', () => {
  const payload = {
    tool_name: 'Write',
    tool_input: {
      file_path: 'src/mytools/thing.mjs',
      content: 'export function thing(){}',
    },
  };
  assert.equal(
    isDeny(runGate(payload)),
    false,
    'isExecutableToolPath must compare whole path segments, not substrings: "mytools" ' +
      'is not the segment "tools"',
  );
});

test('FIXED: a real "tools/" folder is still caught (control for the segment fix)', () => {
  const payload = {
    tool_name: 'Write',
    tool_input: {
      file_path: 'tools/thing.mjs',
      content: 'export function thing(){}',
    },
  };
  assert.ok(
    isDeny(runGate(payload)),
    'a genuine tools/ segment must still trigger the gate',
  );
});

test('FIXED: an MCP-style write tool name is no longer invisible to the gate', () => {
  const payload = {
    tool_name: 'mcp__filesystem__write_file',
    tool_input: {
      file_path: 'scripts/new-tool.mjs',
      content: 'export function parse(){}',
    },
  };
  assert.ok(
    isDeny(runGate(payload)),
    'toolInGroups must classify an MCP write tool by its action segment (write_file)',
  );
});

test('FIXED: a delegation prompt carried in `task` (not prompt/description) is now checked', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: { task: 'Please write a new script that parses CSV files.' },
  };
  assert.ok(
    isDeny(runGate(payload)),
    'delegationPromptOf must read the `task` field',
  );
});

test('OK: the equivalent Write-tool payload IS caught (control)', () => {
  const payload = {
    tool_name: 'Write',
    tool_input: {
      file_path: 'scripts/new-tool.mjs',
      content: 'export function parse(){}',
    },
  };
  assert.ok(isDeny(runGate(payload)), 'control failed');
});
