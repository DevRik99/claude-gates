import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isDeny,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function makeForgeDatabase(activeCwd) {
  const databasePath = join(
    mkdtempSync(join(tmpdir(), 'forge-db-')),
    'forge.db',
  );
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

// `databaseParameter` names which config key carries the DB path (registry: forgeDbPath).
function adoptedProject({
  adopted = true,
  databasePath,
  enabled = true,
  databaseParameter = 'forgeDatabasePath',
} = {}) {
  const gateEntry = { enabled };
  if (databasePath) gateEntry[databaseParameter] = databasePath;
  const files = adopted ? { '.ai/forge.json': '{}' } : {};
  return makeProject({
    prefix: 'forge-flow-',
    config: { gates: { requireForgeRunToEdit: gateEntry } },
    files,
  });
}

function runGate(payload, project, cwd) {
  return runGateProcess(GATE, payload, { project, cwd });
}

const writeSource = () => write('src/x.js', 'x');

test('a project that did NOT adopt forge is never blocked', () => {
  const project = adoptedProject({ adopted: false });
  assert.equal(runGate(writeSource(), project), null);
});

test('adopted forge, no active run: a write is denied', () => {
  const project = adoptedProject({ databasePath: makeForgeDatabase() });
  assert.ok(isDeny(runGate(writeSource(), project)));
});

test('adopted forge, active run for this project: the write is allowed', () => {
  const project = adoptedProject();
  const databasePath = makeForgeDatabase(project);
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
  assert.equal(runGate(writeSource(), project), null);
});

test('adopted forge but DB missing: denied (no runs at all)', () => {
  const project = adoptedProject({
    databasePath: join(tmpdir(), 'does-not-exist', 'forge.db'),
  });
  assert.ok(isDeny(runGate(writeSource(), project)));
});

test('disabled by config: not blocked even in an adopted project', () => {
  const project = adoptedProject({
    databasePath: makeForgeDatabase(),
    enabled: false,
  });
  assert.equal(runGate(writeSource(), project), null);
});

test('a read-only tool (no write/shell) is never blocked', () => {
  const project = adoptedProject({ databasePath: makeForgeDatabase() });
  assert.equal(
    runGate(
      { tool_name: 'Read', tool_input: { file_path: 'src/x.js' } },
      project,
    ),
    null,
  );
});

// ── The registry param name is honored ──────────────────────────────────────────────
test('forgeDbPath (the registry name) is read, and wins over forgeDatabasePath', () => {
  const project = adoptedProject();
  const active = makeForgeDatabase(project);
  const empty = makeForgeDatabase();
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: {
        requireForgeRunToEdit: {
          enabled: true,
          forgeDbPath: active,
          forgeDatabasePath: empty,
        },
      },
    }),
  );
  assert.equal(runGate(writeSource(), project), null);
  const denied = adoptedProject({
    databasePath: empty,
    databaseParameter: 'forgeDbPath',
  });
  assert.ok(isDeny(runGate(writeSource(), denied)));
});

// ── Run cwd matching ────────────────────────────────────────────────────────────────
test('a run whose cwd is an ANCESTOR of the project root covers it', () => {
  const project = adoptedProject();
  const databasePath = makeForgeDatabase(dirname(project));
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: {
        requireForgeRunToEdit: { enabled: true, forgeDbPath: databasePath },
      },
    }),
  );
  assert.equal(runGate(writeSource(), project), null);
});

test('a run cwd with a trailing slash still matches', () => {
  const project = adoptedProject();
  const databasePath = makeForgeDatabase(`${project}/`);
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: {
        requireForgeRunToEdit: { enabled: true, forgeDbPath: databasePath },
      },
    }),
  );
  assert.equal(runGate(writeSource(), project), null);
});

test(
  'on Windows, separator and case differences in the run cwd do not matter',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const project = adoptedProject();
    const databasePath = makeForgeDatabase(
      project.replace(/\\/g, '/').toUpperCase(),
    );
    writeFileSync(
      join(project, '.ai', 'config.json'),
      JSON.stringify({
        gates: {
          requireForgeRunToEdit: { enabled: true, forgeDbPath: databasePath },
        },
      }),
    );
    assert.equal(runGate(writeSource(), project), null);
  },
);

test('a run for a sibling project does not cover this one', () => {
  const project = adoptedProject();
  const databasePath = makeForgeDatabase(`${project}-other`);
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: {
        requireForgeRunToEdit: { enabled: true, forgeDbPath: databasePath },
      },
    }),
  );
  assert.ok(isDeny(runGate(writeSource(), project)));
});

test('`forge: true` in a BOM-prefixed .ai/config.json still counts as adoption', () => {
  const project = adoptedProject({
    adopted: false,
    databasePath: makeForgeDatabase(),
  });
  writeFileSync(
    join(project, '.ai', 'config.json'),
    `\uFEFF${JSON.stringify({
      forge: true,
      gates: {
        requireForgeRunToEdit: {
          enabled: true,
          forgeDbPath: makeForgeDatabase(),
        },
      },
    })}`,
  );
  assert.ok(isDeny(runGate(writeSource(), project)));
});
