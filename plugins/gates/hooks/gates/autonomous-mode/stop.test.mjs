// The autonomous-mode Stop hook: when autonomousMode is ON it re-injects (once per cycle)
// an instruction to decide and proceed instead of ending the turn on a prose question.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isBlock,
  makeProject,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'stop.mjs');

function runHook(payload, config) {
  const project = makeProject({ prefix: 'auton-stop-', config });
  return runGateProcess(HOOK, payload, { project });
}

const ON = { gates: { autonomousMode: true } };

test('autonomousMode ON: the Stop hook BLOCKS and re-injects a decide-and-proceed message', () => {
  const result = runHook({ session_id: 's', stop_hook_active: false }, ON);
  assert.ok(isBlock(result));
  assert.match(messageOf(result), /autonomous/i);
  assert.match(messageOf(result), /proceed|decide/i);
});

test('the block is labeled with the config key, like every other gate', () => {
  const result = runHook({ session_id: 's', stop_hook_active: false }, ON);
  assert.match(messageOf(result), /^\[autonomousMode\] /);
});

test('loop-guard: stop_hook_active=true ALLOWS the stop (never hangs the session)', () => {
  const result = runHook({ session_id: 's', stop_hook_active: true }, ON);
  assert.equal(isBlock(result), false);
});

test('autonomousMode OFF (default): the Stop hook does nothing', () => {
  const result = runHook({ session_id: 's', stop_hook_active: false });
  assert.equal(isBlock(result), false);
});

test('autonomousMode explicitly false: allows the stop', () => {
  const result = runHook(
    { session_id: 's', stop_hook_active: false },
    { gates: { autonomousMode: false } },
  );
  assert.equal(isBlock(result), false);
});

test('fail-safe: an unparseable payload allows the stop, never hangs', () => {
  const result = runHook('not json at all {{{', ON);
  assert.equal(isBlock(result), false);
});

test('dump-defaults protocol: prints the descriptor without touching stdin', () => {
  const result = runGateProcess(HOOK, '', {
    environment: { CLAUDE_GATES_DUMP_DEFAULTS: '1' },
  });
  assert.equal(result.configKey, 'autonomousMode');
  assert.equal(result.enabledByDefault, false);
});
