// Delegation enforcement: with an active forge run, the MAIN agent must not build — only a
// subagent may. Each case is paired with its opposite (main denied / subagent allowed), so a
// gate that stopped firing at all would fail this suite instead of passing it vacuously.
//
// The three gate invariants are re-checked here (read-only, self-remedy, actionable denial)
// because this gate guards the broadest surface in the toolkit, and a hole here is a deadlock.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  delegate,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Las rutas se componen desde homedir() porque una literal absoluta rompe el lint del repo
// (no-restricted-syntax) y ataría el test a un layout concreto de disco.
const TRANSCRIPTS = join(homedir(), '.claude', 'projects', 'p');
const MAIN_TRANSCRIPT = join(TRANSCRIPTS, 'session-1.jsonl');
const SUBAGENT_TRANSCRIPT = join(
  TRANSCRIPTS,
  'session-1',
  'subagents',
  'agent-abc123.jsonl',
);
const WINDOWS_SUBAGENT_TRANSCRIPT = SUBAGENT_TRANSCRIPT.replaceAll('/', '\\');

function forgeDatabase(activeCwd, phase, runId) {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-sub-')), 'forge.db');
  const database = new DatabaseSync(path);
  database.exec(
    'CREATE TABLE runs (id TEXT, cwd TEXT, current_phase TEXT, status TEXT)',
  );
  if (activeCwd) {
    database
      .prepare(
        'INSERT INTO runs (id, cwd, current_phase, status) VALUES (?,?,?,?)',
      )
      .run(runId, activeCwd, phase, 'active');
  }
  database.close();
  return path;
}

function writeGateConfig(root, entry) {
  writeFileSync(
    join(root, '.ai', 'config.json'),
    JSON.stringify({ gates: { requireForgeRunToEdit: entry } }),
  );
}

/**
 * A scratch project whose forge run covers it. Two steps and not one because the run's `cwd`
 * must be the project root, which does not exist until the project is created — so the config
 * naming the DB can only be written afterwards.
 */
function projectWithRun({
  gateOverrides = {},
  phase = 'build',
  runId = 'run-1',
  active = true,
  adopted = true,
  enabled = true,
} = {}) {
  const root = makeProject({
    prefix: 'forge-subagent-',
    config: { gates: {} },
    files: adopted ? { '.ai/forge.json': '{}' } : {},
  });
  const databasePath = forgeDatabase(active ? root : null, phase, runId);
  writeGateConfig(
    root,
    enabled
      ? { enabled: true, forgeDbPath: databasePath, ...gateOverrides }
      : {},
  );
  return root;
}

function asMain(payload) {
  return { ...payload, transcript_path: MAIN_TRANSCRIPT };
}

function asSubagent(payload, transcript = SUBAGENT_TRANSCRIPT) {
  return { ...payload, transcript_path: transcript };
}

function run(payload, options = {}) {
  return runGateProcess(GATE, payload, { project: projectWithRun(options) });
}

test('the MAIN agent is denied a write while a run is active', () => {
  assert.ok(isDeny(run(asMain(write('src/a.ts', 'x')))));
});

test('a SUBAGENT is allowed the same write', () => {
  assert.equal(run(asSubagent(write('src/a.ts', 'x'))), null);
});

test('a subagent transcript with Windows separators is still recognized', () => {
  const result = run(
    asSubagent(write('src/a.ts', 'x'), WINDOWS_SUBAGENT_TRANSCRIPT),
  );
  assert.equal(result, null);
});

test('the MAIN agent is denied a mutating shell command too', () => {
  assert.ok(isDeny(run(asMain(bash('npm run build -- --write')))));
});

test('a payload with no transcript_path is allowed, not treated as the main agent', () => {
  // Porque negar sin poder identificar al llamante congelaría cualquier superficie que no
  // mande el campo.
  assert.equal(run(write('src/a.ts', 'x')), null);
});

test('subagentOnly=false lets the main agent build directly again', () => {
  const result = run(asMain(write('src/a.ts', 'x')), {
    gateOverrides: { subagentOnly: false },
  });
  assert.equal(result, null);
});

test('the denial names the exact tools to call next, and the phase', () => {
  const message = messageOf(run(asMain(write('src/a.ts', 'x'))));
  assert.match(message, /forge_next/);
  assert.match(message, /forge_start_phase/);
  assert.match(message, /forge_complete_phase/);
  assert.match(message, /"build"/);
  assert.match(message, /subagentOnly/);
});

test('a read-only command is never denied, not even to the main agent', () => {
  assert.equal(run(asMain(bash('git status'))), null);
});

test('a read-only head that redirects to a file is NOT read-only', () => {
  assert.ok(isDeny(run(asMain(bash('grep -r x . > out.txt')))));
});

test("the toolkit's own remedy is never denied to the main agent", () => {
  assert.equal(run(asMain(bash('claude-gates task list'))), null);
});

test('a delegation carrying the CURRENT phase token is allowed', () => {
  const result = run(
    asMain(delegate('[forge:run-1:build]\nBuild the plan.', 'builder')),
  );
  assert.equal(result, null);
});

test('a delegation carrying an OLD phase token is denied', () => {
  const result = run(
    asMain(delegate('[forge:run-1:design]\nDesign it.', 'architect')),
  );
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /forge_next/);
});

test("a delegation carrying another RUN's token is denied", () => {
  const result = run(
    asMain(delegate('[forge:run-9:build]\nBuild the plan.', 'builder')),
  );
  assert.ok(isDeny(result));
});

test('a delegation with no forge token at all is allowed', () => {
  // Porque un subagente lanzado durante un run no siempre dice ser la ejecución de una fase,
  // denegarlos convertiría el gate en una jaula.
  const result = run(
    asMain(delegate('Find where the CSV parser lives.', 'Explore')),
  );
  assert.equal(result, null);
});

test('with no active run the main agent is still denied, with the original message', () => {
  const result = run(asMain(write('src/a.ts', 'x')), { active: false });
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /no active forge run/);
});

test('with no active run a delegation is still allowed', () => {
  // Porque delegar es como se arranca un run.
  const result = run(asMain(delegate('anything', 'Explore')), {
    active: false,
  });
  assert.equal(result, null);
});

test('a project that never adopted forge is untouched', () => {
  const result = run(asMain(write('src/a.ts', 'x')), { adopted: false });
  assert.equal(result, null);
});

test('the gate stays silent when the project never opted in', () => {
  // Porque enabledByDefault es false, sin opt-in explícito el gate no existe para el proyecto.
  const result = run(asMain(write('src/a.ts', 'x')), { enabled: false });
  assert.equal(result, null);
});
