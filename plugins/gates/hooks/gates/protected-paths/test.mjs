import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Runs the gate as its own process (it calls process.exit), feeding a payload on stdin
// from inside a temp project so the gate's config lookup is isolated. Returns the parsed
// stdout, or null when the gate allowed (no output).
function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'protected-paths-'));
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

function write(filePath) {
  return { tool_name: 'Write', tool_input: { file_path: filePath } };
}
function bash(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('denies writing to .env and a mutating shell command targeting it', () => {
  assert.ok(isDeny(runGate(write('/repo/.env'))));
  assert.ok(isDeny(runGate(bash('rm .env'))));
  assert.ok(isDeny(runGate(bash('touch package-lock.json'))));
});

test('allows an innocuous write and a read-only command mentioning a protected path', () => {
  assert.equal(runGate(write('/repo/src/index.js')), null);
  assert.equal(runGate(bash('echo "reading .env for debugging"')), null);
  assert.equal(runGate(bash('cat .env')), null);
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(write('/repo/.env'), {
      config: { gates: { blockWritesToProtectedPaths: false } },
    }),
    null,
  );
});

test('project protectedPaths replaces the built-in list', () => {
  const config = {
    gates: {
      blockWritesToProtectedPaths: {
        enabled: true,
        protectedPaths: ['secrets.yaml'],
      },
    },
  };
  // .env no longer protected under the override
  assert.equal(runGate(write('/repo/.env'), { config }), null);
  assert.ok(isDeny(runGate(write('/repo/secrets.yaml'), { config })));
});
