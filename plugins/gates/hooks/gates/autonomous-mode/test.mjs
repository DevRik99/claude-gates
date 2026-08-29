import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Runs the gate in a temp project with HOME isolated (so the real global config is not
// read). `autonomous` writes the flag on. Returns the parsed deny output, or null.
function runGate(payload, { autonomous } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'autonomous-mode-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: { autonomousMode: { enabled: Boolean(autonomous) } },
    }),
  );
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function ask() {
  return {
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'A or B?' }] },
  };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('autonomous mode ON: AskUserQuestion is denied', () => {
  assert.ok(isDeny(runGate(ask(), { autonomous: true })));
});

test('autonomous mode OFF (default): questions pass', () => {
  assert.equal(runGate(ask(), { autonomous: false }), null);
});

test('even ON, a non-question tool is never blocked', () => {
  assert.equal(
    runGate(
      { tool_name: 'Write', tool_input: { file_path: 'x.js', content: '' } },
      { autonomous: true },
    ),
    null,
  );
});
