// Edge audit for forge-flow: fail-open vs fail-closed behavior, and the MCP write/shell
// matcher hole (same structural gap as autonomous-mode's question hole, applied here to
// ACTING_TOOLS = TOOL_GROUPS.write + TOOL_GROUPS.shell).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function adoptedProject() {
  const project = mkdtempSync(join(tmpdir(), 'forge-edge-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(join(project, '.ai', 'forge.json'), '{}');
  return project;
}

function writeConfig(project, forgeDatabasePath, enabled = true) {
  const gateEntry = { enabled };
  if (forgeDatabasePath) gateEntry.forgeDatabasePath = forgeDatabasePath;
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ gates: { requireForgeRunToEdit: gateEntry } }),
  );
}

function runGate(payload, project) {
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

function isWarn(result) {
  const output = result?.hookSpecificOutput;
  return Boolean(output?.additionalContext) && output.permissionDecision !== 'deny';
}

function makeForgeDatabase(directory, activeCwd) {
  const databasePath = join(directory, 'forge.db');
  const database = new DatabaseSync(databasePath);
  database.exec(
    'CREATE TABLE runs (id TEXT, cwd TEXT, current_phase TEXT, status TEXT)',
  );
  if (activeCwd) {
    database
      .prepare('INSERT INTO runs (id, cwd, current_phase, status) VALUES (?,?,?,?)')
      .run('r1', activeCwd, 'build', 'active');
  }
  database.close();
  return databasePath;
}

test('DEGRADED-WARN: a corrupt (non-SQLite) DB file allows the write but WARNS visibly', () => {
  const project = adoptedProject();
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = join(home, 'forge.db');
  writeFileSync(databasePath, 'this is not a sqlite file at all');
  writeConfig(project, databasePath);
  const result = runGate(
    { tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'x' } },
    project,
  );
  // The catch-all no longer returns a silent "run present". A DB that cannot be read yields
  // state 'unknown' -> the gate ALLOWS (a broken lookup must not freeze all work) but emits a
  // warn, so degraded enforcement is never invisible. This is the fix for the old silent
  // fail-open that disabled the whole gate with no trace.
  assert.ok(isWarn(result), 'corrupt DB must allow-with-warning, not allow silently');
});

test('DEGRADED-WARN: DB exists but "runs" table is missing/wrong schema warns visibly', () => {
  const project = adoptedProject();
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = join(home, 'forge.db');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE not_runs (id TEXT)');
  database.close();
  writeConfig(project, databasePath);
  const result = runGate(
    { tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'x' } },
    project,
  );
  assert.ok(isWarn(result), 'schema drift must allow-with-warning, not allow silently');
});

test('FAIL-CLOSED (deny): DB file plainly absent at the configured path denies the write', () => {
  const project = adoptedProject();
  writeConfig(project, join(tmpdir(), 'definitely-does-not-exist-' + Date.now(), 'forge.db'));
  const result = runGate(
    { tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'x' } },
    project,
  );
  // existsSync(forgeDatabasePath) is false -> hasActiveForgeRun returns false directly
  // (line 72: "no DB yet -> no runs at all -> deny") -- this is the ONE path that is
  // fail-closed; every other failure mode (corrupt file, missing table, locked file,
  // node:sqlite unavailable) is fail-open via the catch block.
  assert.ok(isDeny(result), 'FALLA(ok): absent DB is the sole fail-closed path');
});

test('FIXED: an MCP filesystem write tool is now gated (denied with no active run)', () => {
  const project = adoptedProject();
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = makeForgeDatabase(home); // no active run: a real Write would be denied
  writeConfig(project, databasePath);
  const result = runGate(
    {
      tool_name: 'mcp__filesystem__write_file',
      tool_input: { path: 'x.js', content: 'x' },
    },
    project,
  );
  // ACTING_GROUPS = ['execution'] and toolInGroups matches mcp__*__write_file via the write
  // signal, so an MCP filesystem write is now subject to the active-run requirement exactly
  // like a native Write. No active run -> deny.
  assert.ok(isDeny(result), 'MCP write tool must now be gated like a native Write');
});

test('control: the same DB/config DOES deny a native Write (proves the MCP case above is a real gap, not a config issue)', () => {
  const project = adoptedProject();
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = makeForgeDatabase(home); // no active run
  writeConfig(project, databasePath);
  const result = runGate(
    { tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'x' } },
    project,
  );
  assert.ok(isDeny(result), 'FALLA(ok): native Write is correctly denied under identical setup');
});

test('FIXED: an MCP shell/exec tool (mcp__ide__executeCode) is now gated', () => {
  const project = adoptedProject();
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = makeForgeDatabase(home); // no active run
  writeConfig(project, databasePath);
  const result = runGate(
    { tool_name: 'mcp__ide__executeCode', tool_input: { code: 'require("fs").writeFileSync("x.js","x")' } },
    project,
  );
  // forge-flow now consumes the 'execution' group, which includes mcp__ide__executeCode and,
  // via toolInGroups, any mcp__* exec/run surface. No active run -> deny.
  assert.ok(isDeny(result), 'mcp__ide__executeCode must now be gated by forge-flow');
});
