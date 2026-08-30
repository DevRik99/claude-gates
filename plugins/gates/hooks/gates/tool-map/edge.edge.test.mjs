// Edge-case probe for tool-map. Previously the same Edit/new_string content-field gap
// as feature-catalog/sdd-specs meant a legitimately-audited tool created/edited via
// Edit's `new_string` was never recorded in .ai/tool-map.json, so reuse-before-build
// kept re-blocking a tool that was already cleared once. Migrated to
// writtenContentOf()/writtenPathOf() (hook-io.mjs), which read new_string, so this is
// now recorded the same as a Write.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload) {
  const project = mkdtempSync(join(tmpdir(), 'tool-map-edge-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ gates: { maintainToolMap: true } }),
  );
  execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return { mapPath: join(project, '.ai', 'tool-map.json') };
}

test('FIXED: an audited tool written via Edit (new_string) is now recorded', () => {
  const payload = {
    tool_name: 'Edit',
    tool_input: {
      file_path: 'scripts/new-tool.mjs',
      old_string: '',
      new_string: '// audited: nothing does this\nexport function parse(){}',
    },
  };
  const { mapPath } = runGate(payload);
  assert.ok(
    existsSync(mapPath),
    'writtenContentOf must read new_string so an Edit-created tool is persisted',
  );
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  assert.equal(map.tools[0].path, 'scripts/new-tool.mjs');
});

test('OK: the equivalent Write-tool payload IS recorded (control)', () => {
  const payload = {
    tool_name: 'Write',
    tool_input: {
      file_path: 'scripts/new-tool.mjs',
      content: '// audited: nothing does this\nexport function parse(){}',
    },
  };
  const { mapPath } = runGate(payload);
  assert.ok(existsSync(mapPath), 'control failed');
});
