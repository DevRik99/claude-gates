import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeProject, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload) {
  const project = makeProject({
    prefix: 'tool-map-edge-',
    config: { gates: { maintainToolMap: true } },
  });
  runGateProcess(GATE, payload, { project });
  return { mapPath: join(project, '.ai', 'tool-map.json') };
}

test('an audited tool written via Edit (new_string) is recorded', () => {
  const { mapPath } = runGate({
    tool_name: 'Edit',
    tool_input: {
      file_path: 'scripts/new-tool.mjs',
      old_string: '',
      new_string:
        '// justification: no existing tool covers this\nexport function parse(){}',
    },
  });
  assert.ok(existsSync(mapPath));
  assert.equal(
    JSON.parse(readFileSync(mapPath, 'utf8')).tools[0].path,
    'scripts/new-tool.mjs',
  );
});

test('the equivalent Write-tool payload IS recorded (control)', () => {
  const { mapPath } = runGate({
    tool_name: 'Write',
    tool_input: {
      file_path: 'scripts/new-tool.mjs',
      content:
        '// justification: no existing tool covers this\nexport function parse(){}',
    },
  });
  assert.ok(existsSync(mapPath));
});
