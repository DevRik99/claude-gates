import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeProject, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLED = { gates: { maintainToolMap: true } };

function newProject({ config = ENABLED, files } = {}) {
  return makeProject({ prefix: 'tool-map-', config, files });
}

function runGate(
  payload,
  { config, files, project = newProject({ config, files }) } = {},
) {
  runGateProcess(GATE, payload, { project });
  return { project, mapPath: join(project, '.ai', 'tool-map.json') };
}

function readMap(mapPath) {
  return JSON.parse(readFileSync(mapPath, 'utf8'));
}

const AUDITED = '// justification: no existing tool covers this\nexport {}';

test('records a new tool that declares its audit', () => {
  const { mapPath } = runGate(
    write(
      'scripts/csv-parser.mjs',
      '// Justification: no existing tool covers this.\nexport {}',
    ),
  );
  assert.ok(existsSync(mapPath));
  const map = readMap(mapPath);
  assert.equal(map.tools.length, 1);
  assert.equal(map.tools[0].path, 'scripts/csv-parser.mjs');
  assert.match(map.tools[0].audit, /no existing tool/i);
});

test('does not record a tool without an audit line', () => {
  const { mapPath } = runGate(
    write('scripts/thing.mjs', 'export function thing() {}'),
  );
  assert.ok(!existsSync(mapPath));
});

test('ignores a non-tool write', () => {
  const { mapPath } = runGate(write('docs/readme.md', 'audited: hi'));
  assert.ok(!existsSync(mapPath));
});

test('does not duplicate an already-recorded tool', () => {
  const project = newProject();
  runGate(write('scripts/x.mjs', AUDITED), { project });
  const { mapPath } = runGate(write('scripts/x.mjs', AUDITED), { project });
  assert.equal(readMap(mapPath).tools.length, 1);
});

test('disabled by config: does not record', () => {
  const { mapPath } = runGate(write('scripts/y.mjs', AUDITED), {
    config: { gates: { maintainToolMap: false } },
  });
  assert.ok(!existsSync(mapPath));
});

// ── In sync with reuse-before-build ─────────────────────────────────────────────────
test('records exactly what reuse-before-build accepts: a Spanish audit phrase counts', () => {
  const { mapPath } = runGate(
    write(
      'lib/fechas.mjs',
      '// no existe una herramienta que haga esto\nexport {}',
    ),
  );
  assert.match(readMap(mapPath).tools[0].audit, /no existe una herramienta/);
});

test('a test file under a tool folder is not recorded', () => {
  const { mapPath } = runGate(write('lib/__tests__/x.test.mjs', AUDITED));
  assert.ok(!existsSync(mapPath));
});

test('tool folders match by path segment, not substring', () => {
  const { mapPath } = runGate(write('src/mylib/x.mjs', AUDITED));
  assert.ok(!existsSync(mapPath));
});

test('toolFolders / toolExtensions / toolNamePatterns params are honored', () => {
  const config = {
    gates: {
      maintainToolMap: {
        enabled: true,
        toolFolders: ['bin'],
        toolExtensions: ['.rb'],
        toolNamePatterns: [],
      },
    },
  };
  const { project, mapPath } = runGate(write('bin/run.rb', AUDITED), {
    config,
  });
  assert.ok(existsSync(mapPath));
  runGate(write('scripts/run.mjs', AUDITED), { project });
  assert.equal(readMap(mapPath).tools.length, 1);
});

// ── Map hygiene ─────────────────────────────────────────────────────────────────────
test('entries are deduplicated by root-relative normalized path', () => {
  const project = newProject();
  runGate(write('./scripts/x.mjs', AUDITED), { project });
  runGate(write('scripts\\x.mjs', AUDITED), { project });
  const { mapPath } = runGate(
    write(join(project, 'scripts', 'x.mjs'), AUDITED),
    {
      project,
    },
  );
  assert.equal(readMap(mapPath).tools.length, 1);
  assert.equal(readMap(mapPath).tools[0].path, 'scripts/x.mjs');
});

test('entries whose file no longer exists are pruned when the map is written', () => {
  const files = {
    '.ai/tool-map.json': JSON.stringify({
      tools: [
        { path: 'scripts/gone.mjs', audit: 'x' },
        { path: 'scripts/kept.mjs', audit: 'x' },
      ],
    }),
    'scripts/kept.mjs': 'export {}',
  };
  const { mapPath } = runGate(write('scripts/new.mjs', AUDITED), { files });
  const paths = readMap(mapPath).tools.map((tool) => tool.path);
  assert.deepEqual(paths.sort(), ['scripts/kept.mjs', 'scripts/new.mjs']);
});

test('the map lives at the project root even when writing from a subdirectory', () => {
  const project = newProject();
  runGateProcess(GATE, write('scripts/x.mjs', AUDITED), {
    project,
    cwd: join(project, '.ai'),
  });
  assert.ok(existsSync(join(project, '.ai', 'tool-map.json')));
});

test('a toolMapFile that escapes the project root falls back to the default location', () => {
  const config = {
    gates: {
      maintainToolMap: { enabled: true, toolMapFile: '../elsewhere/map.json' },
    },
  };
  const { project, mapPath } = runGate(write('scripts/x.mjs', AUDITED), {
    config,
  });
  assert.ok(existsSync(mapPath));
  assert.ok(!existsSync(join(project, '..', 'elsewhere', 'map.json')));
});
