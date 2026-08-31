// Red/green for the autonomous-mode Stop hook. It closes the hole the PreToolUse half can't
// reach: when the assistant ends a turn on a prose question, the session would just wait.
// This hook, when autonomousMode is ON, re-injects (once per cycle) an instruction to decide
// and proceed instead of waiting.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'stop.mjs');

function makeProject(config) {
  const project = mkdtempSync(join(tmpdir(), 'auton-stop-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  return project;
}

function runHook(payload, project) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isBlock(result) {
  return result?.decision === 'block';
}

test('autonomousMode ON: the Stop hook BLOCKS and re-injects a decide-and-proceed message', () => {
  const project = makeProject({ gates: { autonomousMode: true } });
  const result = runHook({ session_id: 's', stop_hook_active: false }, project);
  assert.ok(isBlock(result), 'must block so the turn does not just wait for the user');
  assert.match(result.reason, /autonomous/i);
  assert.match(result.reason, /proceed|decide/i);
});

test('loop-guard: stop_hook_active=true ALLOWS the stop (never hangs the session)', () => {
  const project = makeProject({ gates: { autonomousMode: true } });
  const result = runHook({ session_id: 's', stop_hook_active: true }, project);
  assert.equal(isBlock(result), false, 'the reminder fires once, then the turn may end');
});

test('autonomousMode OFF (default): the Stop hook does nothing', () => {
  const project = makeProject(); // no config -> default false
  const result = runHook({ session_id: 's', stop_hook_active: false }, project);
  assert.equal(isBlock(result), false);
});

test('autonomousMode explicitly false: allows the stop', () => {
  const project = makeProject({ gates: { autonomousMode: false } });
  const result = runHook({ session_id: 's', stop_hook_active: false }, project);
  assert.equal(isBlock(result), false);
});

test('fail-safe: an unparseable payload allows the stop, never hangs', () => {
  const project = makeProject({ gates: { autonomousMode: true } });
  const out = execFileSync(process.execPath, [HOOK], {
    input: 'not json at all {{{',
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  const result = out.trim() ? JSON.parse(out.trim()) : null;
  assert.equal(isBlock(result), false);
});
