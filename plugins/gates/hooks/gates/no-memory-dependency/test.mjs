import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'no-memory-dependency-'));
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

function delegate(prompt) {
  return { tool_name: 'Agent', tool_input: { prompt } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLED = { config: { gates: { warnMemoryDependencyInBrief: true } } };

test('DENIES when the brief leans on remembered context (now a hard block)', () => {
  const result = runGate(
    delegate('Acordate de lo que hablamos antes y aplica el mismo criterio.'),
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('escape hatch: the marker lets a false-positive memory phrase through', () => {
  // "no te olvides de cerrar el server" directs the subagent's own action, not recalled data.
  assert.equal(
    runGate(
      delegate(
        'No te olvides de cerrar el server al terminar. memory-not-needed',
      ),
      ENABLED,
    ),
    null,
  );
});

test('allows a brief with no memory-dependency phrase', () => {
  assert.equal(
    runGate(
      delegate('Implementa el endpoint de login segun el contrato adjunto.'),
      ENABLED,
    ),
    null,
  );
});

test('allows a memory phrase paired with a deterministic persistence instruction', () => {
  assert.equal(
    runGate(
      delegate(
        'No te olvides de guardar la decision en .ai/decision.md antes de continuar.',
      ),
      ENABLED,
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(
      delegate('Acordate de lo que hablamos antes y aplica el mismo criterio.'),
      {
        config: { gates: { warnMemoryDependencyInBrief: false } },
      },
    ),
    null,
  );
});

test('project memoryDependencyPatterns override replaces the built-in list', () => {
  const config = {
    gates: {
      warnMemoryDependencyInBrief: {
        enabled: true,
        memoryDependencyPatterns: ['como quedamos'],
      },
    },
  };
  // No longer matches the built-in "acordate de" phrase.
  assert.equal(
    runGate(
      delegate('Acordate de lo que hablamos antes y aplica el mismo criterio.'),
      { config },
    ),
    null,
  );
  assert.ok(
    isDeny(
      runGate(delegate('Hacelo como quedamos la ultima vez.'), { config }),
    ),
  );
});
