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
  const project = mkdtempSync(join(tmpdir(), 'no-blocking-'));
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

const ENABLED = { gates: { blockWaitingCommands: true } };

function bash(command, extra = {}) {
  return { tool_name: 'Bash', tool_input: { command, ...extra } };
}
function delegate(prompt) {
  return { tool_name: 'Agent', tool_input: { prompt } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('denies sleep in foreground, a dev server, and a polling loop', () => {
  assert.ok(isDeny(runGate(bash('sleep 30'), { config: ENABLED })));
  assert.ok(isDeny(runGate(bash('npm run dev'), { config: ENABLED })));
  assert.ok(
    isDeny(
      runGate(bash('until curl -sf localhost:3000; do sleep 2; done'), {
        config: ENABLED,
      }),
    ),
  );
});

test('allows an innocuous command and a backgrounded long-runner', () => {
  assert.equal(runGate(bash('git status'), { config: ENABLED }), null);
  assert.equal(
    runGate(bash('npm run dev', { run_in_background: true }), {
      config: ENABLED,
    }),
    null,
  );
  assert.equal(runGate(bash('sleep 30 &'), { config: ENABLED }), null);
});

test('disabled by default: the gate does not run without opting in', () => {
  assert.equal(runGate(bash('sleep 30')), null);
});

test('a delegation prompt telling the subagent to sleep-wait is denied', () => {
  assert.ok(
    isDeny(
      runGate(
        delegate('Please then sleep 60 seconds until the server is ready.'),
        {
          config: ENABLED,
        },
      ),
    ),
  );
});

test('the wait-justified marker with a reason escapes the block', () => {
  assert.equal(
    runGate(
      bash('sleep 30 # WAIT-JUSTIFIED: waiting for migration lock release'),
      {
        config: ENABLED,
      },
    ),
    null,
  );
});

test('project blockingPatterns replaces the built-in list', () => {
  const config = {
    gates: {
      blockWaitingCommands: {
        enabled: true,
        blockingPatterns: [String.raw`\bcustom-block\b`],
      },
    },
  };
  // sleep no longer denied under the override
  assert.equal(runGate(bash('sleep 30'), { config }), null);
  assert.ok(isDeny(runGate(bash('custom-block now'), { config })));
});
