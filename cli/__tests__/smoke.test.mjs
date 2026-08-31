// Tests the smoke runner's classification: a real gate fed its known violation must be
// REACTED; a gate fed a benign payload must be NO_REACTION; a needsState/none fixture is
// SKIPPED. Uses real gate scripts so this doubles as an integration check of a few gates.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runGateFixture, runSmoke, OUTCOMES } from '../smoke.mjs';

test('a gate fed its known violation is REACTED (deny)', () => {
  const result = runGateFixture({
    id: 'block-remote-publish',
    configKey: 'blockRemotePublish',
    enabledByDefault: true,
    type: 'deny',
    payload: {
      tool_name: 'Bash',
      tool_input: { command: 'git ' + 'push origin main' },
    },
    needsState: false,
  });
  assert.equal(result.outcome, OUTCOMES.REACTED);
  assert.equal(result.got, 'deny');
});

test('a gate fed a benign payload is NO_REACTION (the defect the smoke test catches)', () => {
  const result = runGateFixture({
    id: 'block-remote-publish',
    configKey: 'blockRemotePublish',
    enabledByDefault: true,
    type: 'deny',
    payload: { tool_name: 'Bash', tool_input: { command: 'git status' } },
    needsState: false,
  });
  assert.equal(result.outcome, OUTCOMES.NO_REACTION);
  assert.equal(result.got, 'allow');
});

test('a warn gate fed its violation is REACTED (warn)', () => {
  const result = runGateFixture({
    id: 'diagnosis-before-patch',
    configKey: 'warnTimeoutChangeWithoutDiagnosis',
    enabledByDefault: true,
    type: 'warn',
    payload: {
      tool_name: 'Write',
      tool_input: {
        file_path: '/repo/config.js',
        content: 'const REQUEST_TIMEOUT_MS = 30000;',
      },
    },
    needsState: false,
  });
  assert.equal(result.outcome, OUTCOMES.REACTED);
  assert.equal(result.got, 'warn');
});

test('a needsState fixture is SKIPPED, not miscounted as a defect', () => {
  const result = runGateFixture({
    id: 'forge-flow',
    configKey: 'requireForgeRunToEdit',
    enabledByDefault: true,
    type: 'deny',
    payload: {
      tool_name: 'Write',
      tool_input: { file_path: 'src/x.js', content: 'x' },
    },
    needsState: true,
  });
  assert.equal(result.outcome, OUTCOMES.SKIPPED);
});

test('an off-by-default gate is enabled by the runner and still REACTS', () => {
  const result = runGateFixture({
    id: 'root-cause-first',
    configKey: 'requireRootCauseBeforePatch',
    enabledByDefault: false, // runner must write the config to enable it
    type: 'deny',
    payload: {
      tool_name: 'Write',
      tool_input: {
        file_path: '/repo/src/x.js',
        content: '// TODO fix later patch',
      },
    },
    needsState: false,
  });
  assert.equal(result.outcome, OUTCOMES.REACTED, `got ${result.got}`);
});

test('runSmoke tallies outcomes across a manifest', () => {
  const manifest = [
    {
      id: 'block-remote-publish',
      configKey: 'blockRemotePublish',
      enabledByDefault: true,
      type: 'deny',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git ' + 'push origin main' },
      },
      needsState: false,
    },
    {
      id: 'tool-map',
      configKey: 'maintainToolMap',
      enabledByDefault: false,
      type: 'none',
      payload: null,
      needsState: true,
    },
  ];
  const { tally } = runSmoke(manifest);
  assert.equal(tally.reacted, 1);
  assert.equal(tally.skipped, 1);
});
