import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'mandatory-flow-'));
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
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function delegate(prompt, subagentType = 'backend') {
  return {
    tool_name: 'Agent',
    tool_input: { prompt, subagent_type: subagentType },
  };
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

function enableGate(project) {
  writeProjectConfig(project, {
    gates: { requireLiveTaskWhenImplementing: true },
  });
}

test('disabled by default: no pointer file needed', () => {
  const project = makeProject();
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.equal(runGate(project, delegate(prompt)), null);
});

test('denies implementing when no active-task pointer exists on disk', () => {
  const project = makeProject();
  enableGate(project);
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.ok(isDeny(runGate(project, delegate(prompt))));
});

test('allows implementing when the active task has a contract on disk', () => {
  const project = makeProject();
  enableGate(project);
  mkdirSync(join(project, '.ai', 'pipeline', 'checkout-flow'), {
    recursive: true,
  });
  writeFileSync(join(project, '.ai', 'pipeline', 'ACTIVA'), 'checkout-flow');
  writeFileSync(
    join(project, '.ai', 'pipeline', 'checkout-flow', 'asserts.md'),
    '# Asserts\n\nCriterio: cobrar bien.',
  );
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.equal(runGate(project, delegate(prompt)), null);
});

test('denies when the pointer names a task with no contract file', () => {
  const project = makeProject();
  enableGate(project);
  mkdirSync(join(project, '.ai', 'pipeline', 'checkout-flow'), {
    recursive: true,
  });
  writeFileSync(join(project, '.ai', 'pipeline', 'ACTIVA'), 'checkout-flow');
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.ok(isDeny(runGate(project, delegate(prompt))));
});

test('exempt subagent type (qa) is never held to the live-task requirement', () => {
  const project = makeProject();
  enableGate(project);
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.equal(runGate(project, delegate(prompt, 'qa')), null);
});

test('activePointerPath param override points the gate at a custom location', () => {
  const project = makeProject();
  writeProjectConfig(project, {
    gates: {
      requireLiveTaskWhenImplementing: {
        enabled: true,
        activePointerPath: join('.custom', 'ACTIVE'),
      },
    },
  });
  mkdirSync(join(project, '.ai', 'pipeline', 'checkout-flow'), {
    recursive: true,
  });
  writeFileSync(join(project, '.ai', 'pipeline', 'ACTIVA'), 'checkout-flow');
  writeFileSync(
    join(project, '.ai', 'pipeline', 'checkout-flow', 'asserts.md'),
    'Criterio: cobrar bien.',
  );
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  // the default pointer exists and is well-formed, but the override points elsewhere,
  // which does not exist: the gate must deny, proving the param actually took effect.
  assert.ok(isDeny(runGate(project, delegate(prompt))));
});
