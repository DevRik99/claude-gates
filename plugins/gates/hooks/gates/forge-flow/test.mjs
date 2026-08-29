import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Builds a forge SQLite DB with the runs table and optional active run for a given cwd.
function makeForgeDatabase(directory, activeCwd) {
  const databasePath = join(directory, 'forge.db');
  const database = new DatabaseSync(databasePath);
  database.exec(
    'CREATE TABLE runs (id TEXT, cwd TEXT, current_phase TEXT, status TEXT)',
  );
  if (activeCwd) {
    database
      .prepare(
        'INSERT INTO runs (id, cwd, current_phase, status) VALUES (?,?,?,?)',
      )
      .run('r1', activeCwd, 'build', 'active');
  }
  database.close();
  return databasePath;
}

// Runs the gate in a temp project. `adopted` writes the forge marker; `forgeDatabasePath` is
// passed as the gate's param via config. HOME is isolated so the real global config is
// never read. Returns the parsed deny output, or null when the gate allowed.
function runGate(payload, { adopted, forgeDatabasePath, enabled = true } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'forge-flow-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  if (adopted) writeFileSync(join(project, '.ai', 'forge.json'), '{}');
  const gateEntry = { enabled };
  if (forgeDatabasePath) gateEntry.forgeDatabasePath = forgeDatabasePath;
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ gates: { requireForgeRunToEdit: gateEntry } }),
  );
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return { output: out.trim() ? JSON.parse(out.trim()) : null, project };
}

function write(filePath) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'x' },
  };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('a project that did NOT adopt forge is never blocked', () => {
  const { output } = runGate(write('src/x.js'), { adopted: false });
  assert.equal(output, null);
});

test('adopted forge, no active run: a write is denied', () => {
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = makeForgeDatabase(home); // no active run
  const { output } = runGate(write('src/x.js'), {
    adopted: true,
    forgeDatabasePath: databasePath,
  });
  assert.ok(isDeny(output));
});

test('adopted forge, active run for this project: the write is allowed', () => {
  // The run's cwd must equal the project root the gate resolves. Run once to learn the
  // project path, then rebuild the DB with that cwd — the helper makes a fresh project each
  // call, so we seed the DB against the project it actually created.
  const project = mkdtempSync(join(tmpdir(), 'forge-flow-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(join(project, '.ai', 'forge.json'), '{}');
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = makeForgeDatabase(home, project); // active run whose cwd = this project
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: {
        requireForgeRunToEdit: {
          enabled: true,
          forgeDatabasePath: databasePath,
        },
      },
    }),
  );
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(write('src/x.js')),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  assert.equal(out.trim(), '', 'allowed: no output');
});

test('adopted forge but DB missing: denied (no runs at all)', () => {
  const { output } = runGate(write('src/x.js'), {
    adopted: true,
    forgeDatabasePath: join(tmpdir(), 'does-not-exist', 'forge.db'),
  });
  assert.ok(isDeny(output));
});

test('disabled by config: not blocked even in an adopted project', () => {
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = makeForgeDatabase(home);
  const { output } = runGate(write('src/x.js'), {
    adopted: true,
    forgeDatabasePath: databasePath,
    enabled: false,
  });
  assert.equal(output, null);
});

test('a read-only tool (no write/shell) is never blocked', () => {
  const home = mkdtempSync(join(tmpdir(), 'forge-db-'));
  const databasePath = makeForgeDatabase(home);
  const { output } = runGate(
    { tool_name: 'Read', tool_input: { file_path: 'src/x.js' } },
    { adopted: true, forgeDatabasePath: databasePath },
  );
  assert.equal(output, null);
});
