// Red/green for the block-remote-publish gate. This gate was split out of bash-commands so
// remote-publish blocking would carry its OWN enabled flag. These tests plant a real
// violation and confirm: (1) it is denied when the gate is on, (2) it is ALLOWED when the
// project sets blockRemotePublish:false — the config knob the user asked for actually works,
// (3) a delegation prompt that only DESCRIBES a push is not a false positive.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_PATH = join(HERE, '..', 'index.mjs');

/** A throwaway project root (git marker), optionally with an .ai/config.json. */
function makeProject(config) {
  const project = mkdtempSync(join(tmpdir(), 'brp-proj-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  return project;
}

function runGate(rawInput, project) {
  const out = execFileSync(process.execPath, [GATE_PATH], {
    input: rawInput,
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const shellPush = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'git push origin main' },
});

test('planted violation: git push is DENIED when the gate is on (default)', () => {
  const project = makeProject(); // no config -> registry default (true) applies
  const result = runGate(shellPush, project);
  assert.ok(
    isDeny(result),
    'git push must be blocked by default — this is the protection',
  );
  assert.match(
    result.hookSpecificOutput.permissionDecisionReason,
    /blockRemotePublish/,
  );
});

test('the config flag WORKS: blockRemotePublish:false ALLOWS git push', () => {
  // This is the exact case the user hit: a flag in config that should permit the push.
  const project = makeProject({ gates: { blockRemotePublish: false } });
  const result = runGate(shellPush, project);
  assert.equal(
    isDeny(result),
    false,
    'with blockRemotePublish:false the push must go through — the knob the user wanted',
  );
});

test('gh pr merge is denied when on', () => {
  const project = makeProject();
  const result = runGate(
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr merge 42 --squash' },
    }),
    project,
  );
  assert.ok(isDeny(result));
});

test('git -C /repo push (global option) is still caught', () => {
  const project = makeProject();
  const result = runGate(
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git -C /some/repo push origin main' },
    }),
    project,
  );
  assert.ok(isDeny(result), 'a git global option must not bypass the block');
});

test('delegation prompt that only DESCRIBES a push is not a false positive', () => {
  const project = makeProject();
  const result = runGate(
    JSON.stringify({
      tool_name: 'Task',
      tool_input: {
        prompt:
          'I extended the guard so it denies "git push" without authorization.',
      },
    }),
    project,
  );
  assert.equal(
    isDeny(result),
    false,
    'a reporting-verb-governed mention must not deny',
  );
});

test('delegation prompt that ORDERS a push is denied', () => {
  const project = makeProject();
  const result = runGate(
    JSON.stringify({
      tool_name: 'Task',
      tool_input: { prompt: 'Now run git push origin main to publish.' },
    }),
    project,
  );
  assert.ok(isDeny(result));
});

// ── Bypass cases migrated from bash-commands.edge.test.mjs when publish blocking moved
// here. Each documents a shape that must NOT evade the block.

test('env-var-prefixed git push is still caught (FOO=bar git push ...)', () => {
  const project = makeProject();
  assert.ok(
    isDeny(
      runGate(
        JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'FOO=bar git push origin main' },
        }),
        project,
      ),
    ),
  );
});

test('"command gh pr merge" wrapper does not evade the pattern', () => {
  const project = makeProject();
  assert.ok(
    isDeny(
      runGate(
        JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'command gh pr merge 12' },
        }),
        project,
      ),
    ),
  );
});

// Known limitation carried over: a reporting verb inside the lookback window before a real
// order defeats delegation intent detection. Documented, not fixed here (same behavior as
// before the split), so the split is behavior-preserving.
test('KNOWN: reporting verb inside lookback window before an order is allowed (pre-existing limitation)', () => {
  const project = makeProject();
  const result = runGate(
    JSON.stringify({
      tool_name: 'Agent',
      tool_input: {
        prompt:
          'The changelog mentions we should run git push origin main now to finish the release.',
      },
    }),
    project,
  );
  assert.equal(isDeny(result), false);
});
