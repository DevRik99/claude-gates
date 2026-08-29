import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'sdd-specs-'));
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
    gates: { requireSpecBeforeImplementing: true },
  });
}

test('auto-off: no catalog anywhere allows implementation delegation', () => {
  const project = makeProject();
  enableGate(project);
  const prompt =
    'Nivel: STANDARD\nImplementá el checkout citando .ai/features/checkout/tasks/t1/';
  assert.equal(runGate(project, delegate(prompt)), null);
});

test('denies an implementation delegation citing a feature with no contract on disk', () => {
  const project = makeProject();
  enableGate(project);
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  // features tree exists but the cited feature has no contract file
  mkdirSync(join(project, '.ai', 'features', 'checkout'), { recursive: true });
  const prompt =
    'Nivel: STANDARD\nImplementá .ai/features/checkout/ el flujo de pago.';
  assert.ok(isDeny(runGate(project, delegate(prompt))));
});

test('allows an implementation delegation citing a feature with a non-empty contract', () => {
  const project = makeProject();
  enableGate(project);
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  mkdirSync(join(project, '.ai', 'features', 'checkout'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'features', 'checkout', 'brief.md'),
    '# Checkout\n\nObjetivo: cobrar.',
  );
  const prompt =
    'Nivel: STANDARD\nImplementá .ai/features/checkout/ el flujo de pago.';
  assert.equal(runGate(project, delegate(prompt)), null);
});

test('disabled by config: the gate does not run', () => {
  const project = makeProject();
  writeProjectConfig(project, {
    gates: { requireSpecBeforeImplementing: false },
  });
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  mkdirSync(join(project, '.ai', 'features', 'checkout'), { recursive: true });
  const prompt =
    'Nivel: STANDARD\nImplementá .ai/features/checkout/ el flujo de pago.';
  assert.equal(runGate(project, delegate(prompt)), null);
});

test('a prompt that only describes, does not order, is exempt via QUESTION level', () => {
  const project = makeProject();
  enableGate(project);
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  mkdirSync(join(project, '.ai', 'features', 'checkout'), { recursive: true });
  const prompt =
    'Nivel: QUESTION\nExplicá cómo funciona .ai/features/checkout/ hoy.';
  assert.equal(runGate(project, delegate(prompt)), null);
});

test('exemptSubagents param override exempts a custom subagent type', () => {
  const project = makeProject();
  writeProjectConfig(project, {
    gates: {
      requireSpecBeforeImplementing: {
        enabled: true,
        exemptSubagents: ['worker'],
      },
    },
  });
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  mkdirSync(join(project, '.ai', 'features', 'checkout'), { recursive: true });
  const prompt =
    'Nivel: STANDARD\nImplementá .ai/features/checkout/ el flujo de pago.';
  assert.equal(runGate(project, delegate(prompt, 'worker')), null);
});

test('a catalog write moving a feature to spec_ready without contract is denied', () => {
  const project = makeProject();
  enableGate(project);
  mkdirSync(join(project, '.ai', 'features'), { recursive: true });
  // The catalog already exists on disk (an Edit to an existing file); the write below
  // is the new content about to replace it.
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  const write = {
    tool_name: 'Write',
    tool_input: {
      file_path: join(project, '.ai', 'feature_list.json'),
      content: JSON.stringify({
        features: [{ name: 'checkout', status: 'spec_ready' }],
      }),
    },
  };
  assert.ok(isDeny(runGate(project, write)));
});
