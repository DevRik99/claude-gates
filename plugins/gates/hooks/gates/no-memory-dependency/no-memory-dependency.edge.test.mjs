// Edge-case audit for no-memory-dependency. This gate only warns, never denies, so a
// "bypass" here means the warning silently fails to fire for a prompt that really does
// depend on the model's memory, not that anything unsafe was blocked.
// Run: node --test no-memory-dependency.edge.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'no-memory-dependency-edge-'));
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
  return typeof result?.hookSpecificOutput?.additionalContext === 'string';
}

const ENABLED = { config: { gates: { warnMemoryDependencyInBrief: true } } };
const MEMORY_PROMPT = 'Acordate de lo que hablamos antes y aplica el mismo criterio.';

test('FIXED: a delegation tool name outside the native list is now caught via toolInGroups (MCP delegation signal)', () => {
  const result = runGate(
    { tool_name: 'mcp__orchestrator__spawn_agent', tool_input: { prompt: MEMORY_PROMPT } },
    ENABLED,
  );
  assert.ok(isWarn(result), 'gate now warns for the memory-dependency prompt under the MCP tool name too');
});

test('FIXED: prompt carried in a field other than prompt/description/task is now read via delegationPromptOf', () => {
  const result = runGate(
    { tool_name: 'Agent', tool_input: { instructions: MEMORY_PROMPT } },
    ENABLED,
  );
  assert.ok(isWarn(result), 'gate now sees the prompt under "instructions" and warns');
});

test('FIXED: a persistence noun with no verb no longer suppresses the warning', () => {
  // hasPersistenceInstructionNearby now requires an imperative persistence VERB nearby,
  // not merely a noun. A prompt that mentions an unrelated file's name within the window
  // (with no verb instructing anything be saved) no longer suppresses the warning.
  const prompt =
    'Acordate de lo que dijimos del login (el reporte esta en incident.md) y aplica el ' +
    'mismo criterio de siempre.';
  const result = runGate({ tool_name: 'Agent', tool_input: { prompt } }, ENABLED);
  assert.ok(
    isWarn(result),
    'gate now warns: "incident.md" nearby with no persistence verb is not a real persistence instruction',
  );
});

test('OK: a genuine memory-dependency phrase via Agent is warned', () => {
  assert.ok(isWarn(runGate({ tool_name: 'Agent', tool_input: { prompt: MEMORY_PROMPT } }, ENABLED)));
});

test('OK: a memory phrase paired with a real persistence verb still suppresses the warning', () => {
  const result = runGate(
    {
      tool_name: 'Agent',
      tool_input: {
        prompt: 'No te olvides de guardar la decision en .ai/decision.md antes de continuar.',
      },
    },
    ENABLED,
  );
  assert.equal(result, null);
});
