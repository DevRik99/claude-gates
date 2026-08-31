// Edge-case probes for mandatory-flow. Previously: (1) the prompt was read only from
// prompt/Prompt/task, so a Task delegation carrying its brief in `description`
// bypassed the check (shared root cause with implementation-pipeline, test-matrix,
// sdd-specs delegation check); (2) the ACTIVA pointer's slug was used unsanitized in
// join(cwd, '.ai', 'pipeline', slug), so a slug with '..' segments let
// hasTaskContract() resolve outside .ai/pipeline/ and accept an unrelated file
// anywhere on disk as the active task's contract. Both are now fixed:
// delegationPromptOf() reads description too, and readSlug() rejects any slug
// containing a path separator or a '.'/'..' segment, treating it as empty (which
// denies the same way a missing slug does).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'mandatory-flow-edge-'));
  mkdirSync(join(project, '.git'));
  return project;
}

function writeProjectConfig(project, config) {
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
}

function runGate(project, payload) {
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

function enableGate(project) {
  writeProjectConfig(project, {
    gates: { requireLiveTaskWhenImplementing: true },
  });
}

test('FIXED: a Task delegation carrying its brief in `description` is now checked', () => {
  const project = makeProject();
  enableGate(project);
  // No ACTIVA pointer at all -- with delegationPromptOf reading `description`, this
  // now reaches checkLiveTask and denies for the missing pointer.
  const payload = {
    tool_name: 'Task',
    tool_input: {
      description: 'Nivel: STANDARD\nImplementá el checkout.',
      subagent_type: 'backend',
    },
  };
  assert.ok(
    isDeny(runGate(project, payload)),
    'delegationPromptOf reads description and the no-live-task deny fires',
  );
});

test('OK: the equivalent payload using `prompt` with no ACTIVA pointer IS denied (control)', () => {
  const project = makeProject();
  enableGate(project);
  const payload = {
    tool_name: 'Task',
    tool_input: {
      prompt: 'Nivel: STANDARD\nImplementá el checkout.',
      subagent_type: 'backend',
    },
  };
  assert.ok(isDeny(runGate(project, payload)), 'control failed');
});

test('FIXED: a path-traversal slug in ACTIVA no longer lets an unrelated file satisfy hasTaskContract', () => {
  const project = makeProject();
  enableGate(project);
  mkdirSync(join(project, '.ai', 'pipeline'), { recursive: true });
  mkdirSync(join(project, 'evil'), { recursive: true });
  writeFileSync(join(project, 'evil', 'asserts.md'), 'unrelated content');
  writeFileSync(join(project, '.ai', 'pipeline', 'ACTIVA'), '../../evil');
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      prompt: 'Nivel: STANDARD\nImplementá el checkout.',
      subagent_type: 'backend',
    },
  };
  assert.ok(
    isDeny(runGate(project, payload)),
    'readSlug must reject the traversal slug (treated as empty), denying instead of ' +
      'accepting the unrelated file outside .ai/pipeline/',
  );
});
