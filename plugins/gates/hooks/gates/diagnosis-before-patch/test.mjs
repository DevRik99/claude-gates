import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'diagnosis-before-patch-'));
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
    tool_input: { file_path: '/repo/src/config.js', content },
  };
}
function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}

test('warns when a timeout value is being changed', () => {
  assert.ok(isWarn(runGate(write('const REQUEST_TIMEOUT_MS = 30000;'))));
  assert.ok(isWarn(runGate(write('max_retry: 5'))));
});

test('allows content that does not touch a timeout/retry key', () => {
  assert.equal(runGate(write('const x = 1;')), null);
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(write('TIMEOUT_MS = 5000'), {
      config: { gates: { warnTimeoutChangeWithoutDiagnosis: false } },
    }),
    null,
  );
});

test('project timeoutPatterns override replaces the built-in list', () => {
  const config = {
    gates: {
      warnTimeoutChangeWithoutDiagnosis: {
        enabled: true,
        timeoutPatterns: ['custom_limit'],
      },
    },
  };
  assert.equal(runGate(write('TIMEOUT_MS = 5000'), { config }), null);
  assert.ok(isWarn(runGate(write('custom_limit = 5'), { config })));
});
