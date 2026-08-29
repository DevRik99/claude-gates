import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'implementation-pipeline-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
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

function enabledConfig(extraParameters) {
  return {
    gates: {
      requireImplementationPipeline: extraParameters
        ? { enabled: true, ...extraParameters }
        : true,
    },
  };
}

test('disabled by default: a builder delegation with no pipeline stages is allowed', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.equal(runGate(delegate(prompt)), null);
});

test('denies a builder delegation missing all three pipeline stages', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.ok(isDeny(runGate(delegate(prompt), { config: enabledConfig() })));
});

test('allows a builder delegation that declares all three stages', () => {
  const prompt =
    'Nivel: STANDARD\nImplementá el checkout. Contexto verificado: .ai/features/checkout/brief.md. ' +
    'Verificación: npm test debe pasar. Revisión: el principal revisa el diff antes de cerrar.';
  assert.equal(runGate(delegate(prompt), { config: enabledConfig() }), null);
});

test('exempt subagent type (scout) is never held to the pipeline', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  assert.equal(
    runGate(delegate(prompt, 'scout'), { config: enabledConfig() }),
    null,
  );
});

test('a prompt that only describes, does not order, is exempt via QUESTION level', () => {
  const prompt = 'Nivel: QUESTION\nExplicá cómo funciona el checkout hoy.';
  assert.equal(runGate(delegate(prompt), { config: enabledConfig() }), null);
});

test('builderSubagents param override holds a custom type to the pipeline', () => {
  const prompt = 'Nivel: STANDARD\nImplementá el checkout.';
  const config = enabledConfig({ builderSubagents: ['custom-builder'] });
  assert.ok(isDeny(runGate(delegate(prompt, 'custom-builder'), { config })));
  // a type NOT in the overridden list is not assumed to be a builder
  assert.equal(runGate(delegate(prompt, 'backend'), { config }), null);
});
