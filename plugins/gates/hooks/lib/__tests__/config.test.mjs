import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isGateEnabled, gateParameters } from '../config.mjs';

const GATE_KEY = 'blockDestructiveShellCommands';

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'claude-gates-config-'));
}

/** A project directory with a .git marker so config.mjs finds a project root. */
function projectDirectory() {
  const root = temporaryDirectory();
  mkdirSync(join(root, '.git'));
  return root;
}

function writeProjectConfig(root, config) {
  mkdirSync(join(root, '.ai'), { recursive: true });
  writeFileSync(join(root, '.ai', 'config.json'), JSON.stringify(config));
}

function writeGlobalConfig(home, config) {
  const directory = join(home, '.claude', 'claude-gates');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
}

test('isGateEnabled falls back to the registry default when no config exists anywhere', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  assert.equal(isGateEnabled(GATE_KEY, true, project, { home }), true);
  assert.equal(isGateEnabled(GATE_KEY, false, project, { home }), false);
});

test('isGateEnabled reads a bool shorthand entry from the project config', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeProjectConfig(project, { gates: { [GATE_KEY]: false } });
  assert.equal(isGateEnabled(GATE_KEY, true, project, { home }), false);

  const projectTrue = projectDirectory();
  writeProjectConfig(projectTrue, { gates: { [GATE_KEY]: true } });
  assert.equal(isGateEnabled(GATE_KEY, false, projectTrue, { home }), true);
});

test('isGateEnabled reads an object entry with an explicit enabled flag', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeProjectConfig(project, {
    gates: { [GATE_KEY]: { enabled: false, someParam: 'x' } },
  });
  assert.equal(isGateEnabled(GATE_KEY, true, project, { home }), false);
});

test('isGateEnabled treats an object entry with no enabled field as silent (uses registry default)', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeProjectConfig(project, {
    gates: { [GATE_KEY]: { someParam: 'x' } },
  });
  assert.equal(isGateEnabled(GATE_KEY, true, project, { home }), true);
  assert.equal(isGateEnabled(GATE_KEY, false, project, { home }), false);
});

test('isGateEnabled falls back to the global config when the project declares nothing', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeGlobalConfig(home, { gates: { [GATE_KEY]: false } });
  assert.equal(isGateEnabled(GATE_KEY, true, project, { home }), false);
});

test('isGateEnabled: an existing project config wins over the global config even if silent about this gate', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeGlobalConfig(home, { gates: { [GATE_KEY]: false } });
  writeProjectConfig(project, { gates: {} });
  // Project config exists (even without this gate declared): registry default wins,
  // global's false must NOT leak through.
  assert.equal(isGateEnabled(GATE_KEY, true, project, { home }), true);
});

test('isGateEnabled: corrupt project config is treated as absent and falls through to global', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(join(project, '.ai', 'config.json'), '{not valid json');
  writeGlobalConfig(home, { gates: { [GATE_KEY]: false } });
  assert.equal(isGateEnabled(GATE_KEY, true, project, { home }), false);
});

test('isGateEnabled: a malformed entry (string/number) is ignored, falls back to registry default', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeProjectConfig(project, { gates: { [GATE_KEY]: 'yes' } });
  assert.equal(isGateEnabled(GATE_KEY, true, project, { home }), true);
  assert.equal(isGateEnabled(GATE_KEY, false, project, { home }), false);

  const projectNumber = projectDirectory();
  writeProjectConfig(projectNumber, { gates: { [GATE_KEY]: 1 } });
  assert.equal(isGateEnabled(GATE_KEY, false, projectNumber, { home }), false);
});

test('gateParameters returns {} when nothing is declared for the gate', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeProjectConfig(project, { gates: {} });
  assert.deepEqual(gateParameters(GATE_KEY, project, { home }), {});
});

test('gateParameters returns {} for a bool shorthand entry (no params, just enabled)', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeProjectConfig(project, { gates: { [GATE_KEY]: true } });
  assert.deepEqual(gateParameters(GATE_KEY, project, { home }), {});
});

test('gateParameters strips enabled and returns the remaining params from the project config', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeProjectConfig(project, {
    gates: {
      [GATE_KEY]: { enabled: true, protectedPaths: ['a', 'b'] },
    },
  });
  assert.deepEqual(gateParameters(GATE_KEY, project, { home }), {
    protectedPaths: ['a', 'b'],
  });
});

test('gateParameters: project params replace (do not merge with) global params', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  writeGlobalConfig(home, {
    gates: {
      [GATE_KEY]: { protectedPaths: ['global-a'], extra: 'g' },
    },
  });
  writeProjectConfig(project, {
    gates: { [GATE_KEY]: { protectedPaths: ['project-a'] } },
  });
  assert.deepEqual(gateParameters(GATE_KEY, project, { home }), {
    protectedPaths: ['project-a'],
  });
});

test('gateParameters returns {} when no config exists anywhere', () => {
  const project = projectDirectory();
  const home = temporaryDirectory();
  assert.deepEqual(gateParameters(GATE_KEY, project, { home }), {});
});
