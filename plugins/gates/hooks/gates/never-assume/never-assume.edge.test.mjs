import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'never-assume-edge-'));
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

function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}

const ENABLE = {
  config: { gates: { requireVerificationBeforeAssuming: true } },
};

// FIXED: extractContent() now reads through writtenContentOf() (lib/hook-io.mjs), which
// covers NotebookEdit's new_source field, closing the tool-coverage gap this test used to
// document as a bug.
test('FIXED: conjecture phrasing written via NotebookEdit is detected', () => {
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: '/repo/nb.ipynb',
      cell_id: 'x',
      new_source: '# i assume the timezone is UTC',
      cell_type: 'code',
    },
  };
  assert.ok(
    isWarn(runGate(payload, ENABLE)),
    'gate now detects conjecture phrasing via NotebookEdit',
  );
});

// EDGE CASE (BUG): 'invoke_subagent' is a declared delegation tool name (TOOL_GROUPS.delegation
// in lib/hook-io.mjs) and is matched in hooks.json, but extractContent() branches on
// TOOL_GROUPS.delegation.includes(toolName) which DOES include invoke_subagent — so this one
// should actually work. Verify it does (a real behavioral check, not a bug) to make sure the
// delegation branch itself is sound before concluding the write-side gap is the only issue.
test('OK: conjecture phrasing in an invoke_subagent prompt is detected (delegation branch is sound)', () => {
  const payload = {
    tool_name: 'invoke_subagent',
    tool_input: { prompt: 'i assume the config is already loaded, proceed' },
  };
  assert.ok(isWarn(runGate(payload, ENABLE)));
});

// EDGE CASE: false-positive check — "should be" is a very broad conjecture pattern that can
// match ordinary correct engineering prose describing an invariant, not an unverified guess,
// e.g. "the response should be a 200 for valid input" (spec language, not conjecture).
test('OK/expected-noise: "should be" fires even on spec-style invariant language (broad pattern, not a bug but a known false-positive source)', () => {
  const result = runGate(
    {
      tool_name: 'Write',
      tool_input: {
        file_path: '/repo/x.js',
        content:
          '// per the spec, the response should be a 200 for valid input',
      },
    },
    ENABLE,
  );
  assert.ok(
    isWarn(result),
    'documents that "should be" over-fires on legitimate spec prose, not just conjecture',
  );
});
