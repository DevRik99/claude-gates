// Edge-case probe for test-matrix. Previously the prompt was read only from
// toolInput.prompt/Prompt/task, the same root cause shared by implementation-pipeline,
// mandatory-flow and the sdd-specs delegation check: a Task delegation carrying its
// brief in `description` was invisible. Migrated to delegationPromptOf()
// (hook-io.mjs), so this is now caught.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'test-matrix-edge-'));
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

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

function enabledConfig() {
  return { gates: { requireTestMatrixWhenImplementing: true } };
}

test('FIXED: a Task delegation carrying its brief in `description` is now checked', () => {
  const payload = {
    tool_name: 'Task',
    tool_input: {
      description: 'Nivel: STANDARD\nImplementá el cobro de la cuota.',
      subagent_type: 'backend',
    },
  };
  assert.ok(
    isDeny(runGate(payload, { config: enabledConfig() })),
    'delegationPromptOf reads description and the missing-test-matrix deny fires',
  );
});

test('OK: the equivalent payload using `prompt` IS caught (control)', () => {
  const payload = {
    tool_name: 'Task',
    tool_input: {
      prompt: 'Nivel: STANDARD\nImplementá el cobro de la cuota.',
      subagent_type: 'backend',
    },
  };
  assert.ok(isDeny(runGate(payload, { config: enabledConfig() })), 'control failed');
});
