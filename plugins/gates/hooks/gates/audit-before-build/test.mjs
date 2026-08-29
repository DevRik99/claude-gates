import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'audit-before-build-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
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

function delegate(prompt) {
  return { tool_name: 'Agent', tool_input: { prompt } };
}
function write(filePath, content) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLE = { config: { gates: { requireAuditBeforeBuilding: true } } };

test('denies delegation to create a new tool without audit evidence', () => {
  assert.ok(
    isDeny(runGate(delegate('create a new script that checks X'), ENABLE)),
  );
});

test('allows delegation with audit evidence stated', () => {
  assert.equal(
    runGate(
      delegate(
        'create a new script that checks X. audited and no existing tool covers this.',
      ),
      ENABLE,
    ),
    null,
  );
});

test('denies writing a new executable tool file without a justification comment', () => {
  assert.equal(
    runGate(
      write('/repo/scripts/check-thing.mjs', 'export function run() {}'),
      ENABLE,
    )?.hookSpecificOutput?.permissionDecision,
    'deny',
  );
});

test('allows writing a tool file with a justification comment', () => {
  assert.equal(
    runGate(
      write(
        '/repo/scripts/check-thing.mjs',
        '// justification: no existing tool does this\nexport function run() {}',
      ),
      ENABLE,
    ),
    null,
  );
});

test('allows a write outside tool folders or non-executable extension', () => {
  assert.equal(
    runGate(write('/repo/docs/notes.md', 'plain notes'), ENABLE),
    null,
  );
  assert.equal(runGate(write('/repo/scripts/data.json', '{}'), ENABLE), null);
});

test('disabled by default (registry default is false)', () => {
  assert.equal(runGate(delegate('create a new script that checks X')), null);
});
