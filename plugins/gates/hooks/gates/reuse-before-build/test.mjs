import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Runs the gate as a child process inside a temp project (with .git so config/root resolve).
// The gate is off by default, so config enables it unless a test overrides that. An optional
// tool map is seeded. Returns parsed stdout or null when it allowed.
function runGate(payload, { config, toolMap } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'reuse-before-build-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  const effectiveConfig = config ?? {
    gates: { requireReuseCheckBeforeBuilding: true },
  };
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify(effectiveConfig),
  );
  if (toolMap) {
    writeFileSync(
      join(project, '.ai', 'tool-map.json'),
      JSON.stringify(toolMap),
    );
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

function writeTool(content) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: 'scripts/csv-parser.mjs', content },
  };
}
function delegate(prompt) {
  return { tool_name: 'Agent', tool_input: { prompt } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

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
      delegate('Write a new script for CSV — I audited and nothing does this.'),
    ),
    null,
  );
});

test('allows when the need is already recorded in the tool map', () => {
  const toolMap = { tools: [{ path: 'scripts/csv-parser.mjs', audit: 'x' }] };
  assert.equal(runGate(writeTool('export {}'), { toolMap }), null);
});

test('ignores non-tool writes (a plain markdown file)', () => {
  assert.equal(
    runGate({
      tool_name: 'Write',
      tool_input: { file_path: 'docs/readme.md', content: 'hello' },
    }),
    null,
  );
});

// ── FIX 1: structural map match (no more false "already covered" by word overlap) ──
test('map match is structural: an UNRELATED entry mentioning a shared word no longer clears the build', () => {
  // Old bug: any 4+-letter word of the target appearing anywhere in the JSON cleared it, so
  // a `csv-parser.mjs` build was cleared by an entry whose audit merely said "parser".
  const toolMap = {
    tools: [
      { path: 'scripts/xml-thing.mjs', audit: 'a parser for XML configs' },
    ],
  };
  assert.ok(
    isDeny(runGate(writeTool('export {}'), { toolMap })),
    'the word "parser" in an unrelated entry must not clear csv-parser',
  );
});

test('map match clears only when the tool BASENAME matches a recorded path', () => {
  const toolMap = { tools: [{ path: 'other/csv-parser.ts', audit: 'x' }] };
  assert.equal(
    runGate(writeTool('export {}'), { toolMap }),
    null,
    'same basename (csv-parser) in the map clears it regardless of folder/extension',
  );
});

// ── FIX 2: scope beyond the four tool folders (helpers/composables + name patterns) ──
test('flags a helper OUTSIDE scripts/hooks/tools/gates (a composable in a feature folder)', () => {
  assert.ok(
    isDeny(
      runGate({
        tool_name: 'Write',
        tool_input: {
          file_path: 'src/features/user/useDebounce.ts',
          content: 'export function useDebounce() {}',
        },
      }),
    ),
    'useX name pattern makes it a tool candidate anywhere',
  );
});

test('flags a file in lib/ and one named *.helper.ts', () => {
  assert.ok(
    isDeny(
      runGate({
        tool_name: 'Write',
        tool_input: { file_path: 'lib/format.mjs', content: 'export {}' },
      }),
    ),
  );
  assert.ok(
    isDeny(
      runGate({
        tool_name: 'Write',
        tool_input: { file_path: 'src/date.helper.ts', content: 'export {}' },
      }),
    ),
  );
});

// ── FIX 3: bilingual build-intent (Spanish briefs now trip the reuse check) ──
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

// ── FIX 4: installed dependency covers the need ──
test('an installed dependency with the tool name clears the build', () => {
  // A package.json declaring `csv-parser` means the wheel already exists — reuse it.
  const config = { gates: { requireReuseCheckBeforeBuilding: true } };
  const project = mkdtempSync(join(tmpdir(), 'reuse-dep-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ dependencies: { 'csv-parser': '^1.0.0' } }),
  );
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(writeTool('export {}')),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  assert.equal(out.trim() ? JSON.parse(out.trim()) : null, null);
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(writeTool('export {}'), {
      config: { gates: { requireReuseCheckBeforeBuilding: false } },
    }),
    null,
  );
});
