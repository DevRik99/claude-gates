import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'root-cause-first-'));
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

function write(content) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: '/repo/src/x.js', content },
  };
}
function delegate(prompt) {
  return { tool_name: 'Agent', tool_input: { prompt } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLE = { config: { gates: { requireRootCauseBeforePatch: true } } };

test('denies a patch-marker comment in a write', () => {
  assert.ok(isDeny(runGate(write('// TODO fix later patch'), ENABLE)));
});

test('denies the same marker inside a delegation prompt', () => {
  assert.ok(
    isDeny(runGate(delegate('add a // TODO fix later patch comment'), ENABLE)),
  );
});

test('allows innocuous content', () => {
  assert.equal(runGate(write('const x = 1;'), ENABLE), null);
});

test('disabled by default (registry default is false)', () => {
  assert.equal(runGate(write('// TODO fix later patch')), null);
});

test('project patchMarkerPatterns override replaces the built-in list', () => {
  const config = {
    gates: {
      requireRootCauseBeforePatch: {
        enabled: true,
        patchMarkerPatterns: ['hack-me-later'],
      },
    },
  };
  assert.equal(runGate(write('// TODO fix later patch'), { config }), null);
  assert.ok(isDeny(runGate(write('// hack-me-later'), { config })));
});
