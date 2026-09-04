// Fail-open vs fail-closed behavior, and MCP write/shell coverage.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isDeny,
  isWarn,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function adoptedProject(databasePath) {
  return makeProject({
    prefix: 'forge-edge-',
    config: {
      gates: {
        requireForgeRunToEdit: { enabled: true, forgeDbPath: databasePath },
      },
    },
    files: { '.ai/forge.json': '{}' },
  });
}

function makeForgeDatabase() {
  const databasePath = join(
    mkdtempSync(join(tmpdir(), 'forge-db-')),
    'forge.db',
  );
  const database = new DatabaseSync(databasePath);
  database.exec(
    'CREATE TABLE runs (id TEXT, cwd TEXT, current_phase TEXT, status TEXT)',
  );
  database.close();
  return databasePath;
}

const writeSource = () => write('x.js', 'x');

test('DEGRADED-WARN: a corrupt (non-SQLite) DB file allows the write but WARNS visibly', () => {
  const databasePath = join(
    mkdtempSync(join(tmpdir(), 'forge-db-')),
    'forge.db',
  );
  writeFileSync(databasePath, 'this is not a sqlite file at all');
  const result = runGateProcess(GATE, writeSource(), {
    project: adoptedProject(databasePath),
  });
  assert.ok(isWarn(result));
});

test('DEGRADED-WARN: DB exists but "runs" table is missing/wrong schema warns visibly', () => {
  const databasePath = join(
    mkdtempSync(join(tmpdir(), 'forge-db-')),
    'forge.db',
  );
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE not_runs (id TEXT)');
  database.close();
  const result = runGateProcess(GATE, writeSource(), {
    project: adoptedProject(databasePath),
  });
  assert.ok(isWarn(result));
});

test('FAIL-CLOSED (deny): DB file plainly absent at the configured path denies the write', () => {
  const result = runGateProcess(GATE, writeSource(), {
    project: adoptedProject(
      join(tmpdir(), `definitely-does-not-exist-${Date.now()}`, 'forge.db'),
    ),
  });
  assert.ok(isDeny(result));
});

test('an MCP filesystem write tool is gated (denied with no active run)', () => {
  const result = runGateProcess(
    GATE,
    {
      tool_name: 'mcp__filesystem__write_file',
      tool_input: { path: 'x.js', content: 'x' },
    },
    { project: adoptedProject(makeForgeDatabase()) },
  );
  assert.ok(isDeny(result));
});

test('control: the same DB/config denies a native Write', () => {
  const result = runGateProcess(GATE, writeSource(), {
    project: adoptedProject(makeForgeDatabase()),
  });
  assert.ok(isDeny(result));
});

test('an MCP shell/exec tool (mcp__ide__executeCode) is gated', () => {
  const result = runGateProcess(
    GATE,
    {
      tool_name: 'mcp__ide__executeCode',
      tool_input: { code: 'require("fs").writeFileSync("x.js","x")' },
    },
    { project: adoptedProject(makeForgeDatabase()) },
  );
  assert.ok(isDeny(result));
});
