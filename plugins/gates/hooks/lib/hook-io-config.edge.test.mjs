// Edge audit for the common scaffolding (hook-io.mjs, config.mjs) that every gate shares.
// Uses a minimal real gate built on runGate() so behavior is exercised end to end rather
// than by reading source and guessing.
//
// Findings:
//   1. Config precedence: a project config that EXISTS but omits a given gate key falls
//      through to the REGISTRY DEFAULT passed by the gate (not to the global config) --
//      confirmed by gatesLayerFor's early return the moment projectData is truthy
//      (config.mjs line 80-81: `if (projectData) return projectData.gates ?? {};`). A
//      global config with the key enabled is never consulted once a project config file
//      exists at all, even if it says nothing about this particular gate.
//   2. A corrupted project config.json does NOT silently disable protection: readJsonOrNull
//      returns null on parse failure, gatesLayerFor then falls through to the global config
//      layer, and if that too is corrupt/absent, isGateEnabled falls back to the gate's own
//      registryDefault. Verified with a gate whose registryDefault is `true` (deny-by-default)
//      to prove corruption doesn't fail open when the default is protective.
//   3. toolNameOf/runGate coalescing (payload.tool_name ?? payload.name ?? '' -> '' on
//      unparseable JSON) is exercised directly here against the shared helpers, independent
//      of any specific gate's matcher set.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A minimal probe gate: denies unconditionally whenever it runs and is enabled, with a
// registryDefault of true (protective/deny-by-default), so we can distinguish "ran and
// allowed via toolName mismatch" from "did not run because disabled".
const PROBE_GATE_SOURCE = `
import { runGate, deny } from ${JSON.stringify(pathToFileURL(join(HERE, 'hook-io.mjs')).href)};
runGate(
  { id: 'probe-gate', configKey: 'probeGate', enabledByDefault: true },
  ({ toolName }) => {
    deny('probe-gate', 'toolName=' + JSON.stringify(toolName));
  },
);
`;

function writeProbeGate(directory) {
  const gatePath = join(directory, 'probe-gate.mjs');
  writeFileSync(gatePath, PROBE_GATE_SOURCE);
  return gatePath;
}

function runProbe(gatePath, rawInput, project) {
  const out = execFileSync(process.execPath, [gatePath], {
    input: rawInput,
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('toolNameOf/runGate: unparseable JSON payload coalesces toolName to empty string, not null', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hookio-edge-'));
  const project = mkdtempSync(join(tmpdir(), 'hookio-proj-'));
  mkdirSync(join(project, '.git'));
  const gatePath = writeProbeGate(scratch);
  // registryDefault=true means the probe gate is ON with no config at all; it always denies
  // when it runs, and the deny message embeds the resolved toolName so we can inspect it.
  const result = runProbe(gatePath, 'not json at all {{{', project);
  assert.ok(isDeny(result));
  assert.match(
    result.hookSpecificOutput.permissionDecisionReason,
    /toolName=""/,
    'confirms toolNameOf(...) ?? \'\' resolves corrupt payloads to the empty string, ' +
      'the exact value that fails to match any TOOL_GROUPS Set',
  );
});

test('config precedence: project config exists but omits the gate key -> registryDefault wins, NOT global config', () => {
  const project = mkdtempSync(join(tmpdir(), 'hookio-proj-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  // Project config exists, and declares gates, but never mentions 'probeGate'.
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ gates: { someOtherGate: true } }),
  );
  // Global config (same HOME as project, since HOME=project below) explicitly disables it.
  // If precedence were "most specific explicit setting wins", global's false should apply.
  // If precedence is "project file existing short-circuits global entirely", the probe's
  // own registryDefault (true) should apply instead, ignoring global.
  const home = project; // isolate HOME to a dir we control, distinct from project root marker use
  mkdirSync(join(home, '.claude', 'claude-gates'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'claude-gates', 'config.json'),
    JSON.stringify({ gates: { probeGate: false } }),
  );
  const scratch = mkdtempSync(join(tmpdir(), 'hookio-edge-'));
  const gatePath = writeProbeGate(scratch);
  const out = execFileSync(process.execPath, [gatePath], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: {} }),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const result = out.trim() ? JSON.parse(out.trim()) : null;
  assert.ok(
    isDeny(result),
    'PASA(confirmed): project config existing makes gatesLayerFor return early with {} ' +
      'for gates it does not mention, so registryDefault (true/deny) wins over the global ' +
      'config saying false -- global is never consulted once ANY project config.json exists',
  );
});

test('config precedence: NO project config at all -> global config value is honored', () => {
  const project = mkdtempSync(join(tmpdir(), 'hookio-proj-'));
  mkdirSync(join(project, '.git'));
  // No .ai/config.json in the project at all.
  const home = mkdtempSync(join(tmpdir(), 'hookio-home-'));
  mkdirSync(join(home, '.claude', 'claude-gates'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'claude-gates', 'config.json'),
    JSON.stringify({ gates: { probeGate: false } }),
  );
  const scratch = mkdtempSync(join(tmpdir(), 'hookio-edge-'));
  const gatePath = writeProbeGate(scratch);
  const out = execFileSync(process.execPath, [gatePath], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: {} }),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const result = out.trim() ? JSON.parse(out.trim()) : null;
  assert.equal(
    result,
    null,
    'control: with no project config file present at all, global config IS consulted and ' +
      'its false correctly disables the gate -- confirms the precedence bug above is ' +
      'specifically "project file exists" short-circuiting, not "global never works"',
  );
});

test('corrupted project config.json does not silently disable a protective (default-on) gate', () => {
  const project = mkdtempSync(join(tmpdir(), 'hookio-proj-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(join(project, '.ai', 'config.json'), '{ this is not valid json ][');
  const home = mkdtempSync(join(tmpdir(), 'hookio-home-'));
  const scratch = mkdtempSync(join(tmpdir(), 'hookio-edge-'));
  const gatePath = writeProbeGate(scratch);
  const out = execFileSync(process.execPath, [gatePath], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: {} }),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const result = out.trim() ? JSON.parse(out.trim()) : null;
  assert.ok(
    isDeny(result),
    'FALLA(ok): corrupt project config treated as absent -> falls through to global (none) ' +
      '-> registryDefault (true) -> still protected, matching config.mjs\'s documented intent',
  );
});

test('corrupted GLOBAL config.json (no project config) does not silently disable a protective gate', () => {
  const project = mkdtempSync(join(tmpdir(), 'hookio-proj-'));
  mkdirSync(join(project, '.git'));
  const home = mkdtempSync(join(tmpdir(), 'hookio-home-'));
  mkdirSync(join(home, '.claude', 'claude-gates'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'claude-gates', 'config.json'),
    '{ not valid json at all',
  );
  const scratch = mkdtempSync(join(tmpdir(), 'hookio-edge-'));
  const gatePath = writeProbeGate(scratch);
  const out = execFileSync(process.execPath, [gatePath], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: {} }),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const result = out.trim() ? JSON.parse(out.trim()) : null;
  assert.ok(
    isDeny(result),
    'FALLA(ok): corrupt global config also treated as absent -> registryDefault wins',
  );
});
