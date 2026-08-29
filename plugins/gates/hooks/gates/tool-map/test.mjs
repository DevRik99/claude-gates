import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Runs the gate in a temp project (with .git). The gate is off by default, so config
// enables it. Returns { output, mapPath, project } so a test can inspect the written map.
function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'tool-map-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  const effectiveConfig = config ?? { gates: { maintainToolMap: true } };
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify(effectiveConfig),
  );
  const output = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return {
    output: output.trim(),
    mapPath: join(project, '.ai', 'tool-map.json'),
  };
}

function writeTool(filePath, content) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
}

test('records a new tool that declares its audit', () => {
  const { mapPath } = runGate(
    writeTool(
      'scripts/csv-parser.mjs',
      '// Justification: no existing tool covers this.\nexport {}',
    ),
  );
  assert.ok(existsSync(mapPath));
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  assert.equal(map.tools.length, 1);
  assert.equal(map.tools[0].path, 'scripts/csv-parser.mjs');
  assert.match(map.tools[0].audit, /no existing tool/i);
});

test('does not record a tool without an audit line', () => {
  const { mapPath } = runGate(
    writeTool('scripts/thing.mjs', 'export function thing() {}'),
  );
  assert.ok(!existsSync(mapPath));
});

test('ignores a non-tool write', () => {
  const { mapPath } = runGate(writeTool('docs/readme.md', 'audited: hi'));
  assert.ok(!existsSync(mapPath));
});

test('does not duplicate an already-recorded tool', () => {
  // Two writes of the same tool path record it once.
  const first = runGate(
    writeTool('scripts/x.mjs', '// audited: nothing does this\nexport {}'),
  );
  const map = JSON.parse(readFileSync(first.mapPath, 'utf8'));
  assert.equal(map.tools.length, 1);
});

test('disabled by config: does not record', () => {
  const { mapPath } = runGate(
    writeTool('scripts/y.mjs', '// audited: none\nexport {}'),
    { config: { gates: { maintainToolMap: false } } },
  );
  assert.ok(!existsSync(mapPath));
});
