import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  delegate,
  isDeny,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLED = { gates: { requireReuseCheckBeforeBuilding: true } };

function runGate(payload, { config = ENABLED, toolMap, files = {}, cwd } = {}) {
  const seeded = { ...files };
  if (toolMap) seeded['.ai/tool-map.json'] = JSON.stringify(toolMap);
  const project = makeProject({
    prefix: 'reuse-before-build-',
    config,
    files: seeded,
  });
  return runGateProcess(GATE, payload, { project, cwd });
}

const writeTool = (content) => write('scripts/csv-parser.mjs', content);

test('denies building a new tool without an audit', () => {
  assert.ok(isDeny(runGate(writeTool('export function parse() {}'))));
  assert.ok(
    isDeny(
      runGate(delegate('Please write a new script that parses CSV files.')),
    ),
  );
});

test('allows when the text declares an audit was done', () => {
  assert.equal(
    runGate(
      writeTool('// Justification: no existing tool covers this.\nexport {}'),
    ),
    null,
  );
  assert.equal(
    runGate(
      delegate(
        'Write a new script for CSV — I checked existing tools and no tool covers it.',
      ),
    ),
    null,
  );
});

test('allows when the need is already recorded in the tool map', () => {
  const toolMap = { tools: [{ path: 'scripts/csv-parser.mjs', audit: 'x' }] };
  assert.equal(runGate(writeTool('export {}'), { toolMap }), null);
});

test('ignores non-tool writes (a plain markdown file)', () => {
  assert.equal(runGate(write('docs/readme.md', 'hello')), null);
});

test('map match is structural: an UNRELATED entry mentioning a shared word does not clear the build', () => {
  const toolMap = {
    tools: [
      { path: 'scripts/xml-thing.mjs', audit: 'a parser for XML configs' },
    ],
  };
  assert.ok(isDeny(runGate(writeTool('export {}'), { toolMap })));
});

test('map match clears only when the tool BASENAME matches a recorded path', () => {
  const toolMap = { tools: [{ path: 'other/csv-parser.ts', audit: 'x' }] };
  assert.equal(runGate(writeTool('export {}'), { toolMap }), null);
});

test('flags a helper OUTSIDE scripts/hooks/tools/gates (a composable in a feature folder)', () => {
  assert.ok(
    isDeny(
      runGate(
        write(
          'src/features/user/useDebounce.ts',
          'export function useDebounce() {}',
        ),
      ),
    ),
  );
});

test('flags a file in lib/ and one named *.helper.ts', () => {
  assert.ok(isDeny(runGate(write('lib/format.mjs', 'export {}'))));
  assert.ok(isDeny(runGate(write('src/date.helper.ts', 'export {}'))));
});

test('DENIES a Spanish delegation asking to build a tool', () => {
  assert.ok(
    isDeny(runGate(delegate('Armá un verificador nuevo para los importes.'))),
  );
  assert.ok(isDeny(runGate(delegate('Hacé un helper que formatee fechas.'))));
});

test('a Spanish audit phrase clears the Spanish build', () => {
  assert.equal(
    runGate(
      delegate(
        'Armá un verificador — ya existe? no, no existe una herramienta.',
      ),
    ),
    null,
  );
});

test('an installed dependency with the tool name clears the build', () => {
  const files = {
    'package.json': JSON.stringify({
      dependencies: { 'csv-parser': '^1.0.0' },
    }),
  };
  assert.equal(runGate(writeTool('export {}'), { files }), null);
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(writeTool('export {}'), {
      config: { gates: { requireReuseCheckBeforeBuilding: false } },
    }),
    null,
  );
});

// ── Build intent covers every creation verb, not only the first ─────────────────────
test('a creation verb late in the prompt still counts ("Make sure to review..., then create a helper")', () => {
  assert.ok(
    isDeny(
      runGate(
        delegate(
          'Make sure to review the existing conventions in the repo first, then create a helper for dates.',
        ),
      ),
    ),
  );
});

test('a noun is never cut mid-word by the verb window ("components" is not "component")', () => {
  assert.ok(
    isDeny(runGate(delegate('create the shared reusable ui components'))),
  );
});

// ── Non-tool files are skipped ──────────────────────────────────────────────────────
test('a test file under a tool folder is never a wheel (hooks/gates/foo/test.mjs)', () => {
  assert.equal(runGate(write('hooks/gates/foo/test.mjs', 'export {}')), null);
  assert.equal(runGate(write('lib/__tests__/format.test.mjs', 'x')), null);
});

test('a name pattern matches by whole token (microservice.ts is not a *.service.ts)', () => {
  assert.equal(runGate(write('src/microservice.ts', 'export {}')), null);
  assert.ok(isDeny(runGate(write('src/user.service.ts', 'export {}'))));
});

// ── Project root and map path ───────────────────────────────────────────────────────
test('the tool map is read from a project root marked by .ai/ alone (no .git)', () => {
  const project = makeProject({
    prefix: 'reuse-before-build-',
    git: false,
    config: ENABLED,
    files: {
      '.ai/tool-map.json': JSON.stringify({
        tools: [{ path: 'scripts/csv-parser.mjs' }],
      }),
    },
  });
  const sub = join(project, 'src');
  mkdirSync(sub);
  assert.equal(
    runGateProcess(GATE, writeTool('export {}'), { project, cwd: sub }),
    null,
  );
});

test('a toolMapFile that escapes the project root is ignored (the default is used instead)', () => {
  const config = {
    gates: {
      requireReuseCheckBeforeBuilding: {
        enabled: true,
        toolMapFile: '../outside/tool-map.json',
      },
    },
  };
  const toolMap = { tools: [{ path: 'scripts/csv-parser.mjs' }] };
  assert.equal(runGate(writeTool('export {}'), { config, toolMap }), null);
});
