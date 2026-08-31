import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SCOPES,
  findProjectRoot,
  configPathFor,
  readConfig,
  mergeConfig,
  writeConfig,
} from '../config.mjs';

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'claude-gates-'));
}

test('findProjectRoot climbs to the .git directory and falls back to the start', () => {
  const root = temporaryDirectory();
  mkdirSync(join(root, '.git'));
  const nested = join(root, 'src', 'deep');
  mkdirSync(nested, { recursive: true });
  assert.equal(findProjectRoot(nested), root);

  const loose = temporaryDirectory();
  assert.equal(findProjectRoot(loose), loose);
});

test('findProjectRoot never climbs into the home directory', () => {
  const fakeHome = temporaryDirectory();
  mkdirSync(join(fakeHome, '.ai'));
  const project = join(fakeHome, 'repos', 'app');
  mkdirSync(project, { recursive: true });
  assert.equal(findProjectRoot(project, { home: fakeHome }), project);
});

test('configPathFor resolves both scopes', () => {
  const home = temporaryDirectory();
  const project = temporaryDirectory();
  mkdirSync(join(project, '.ai'));
  assert.equal(
    configPathFor(SCOPES.GLOBAL, { home }),
    join(home, '.claude', 'claude-gates', 'config.json'),
  );
  assert.equal(
    configPathFor(SCOPES.PROJECT, { cwd: project }),
    join(project, '.ai', 'config.json'),
  );
  assert.throws(() => configPathFor('nope'), /Unknown scope/);
});

test('readConfig distinguishes missing, valid and corrupt', () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'config.json');
  assert.deepEqual(readConfig(path), {
    exists: false,
    data: {},
    corrupt: false,
  });
  writeFileSync(path, '{"autoCommit":true}');
  assert.deepEqual(readConfig(path), {
    exists: true,
    data: { autoCommit: true },
    corrupt: false,
  });
  writeFileSync(path, '{nope');
  assert.equal(readConfig(path).corrupt, true);
});

test('readConfig strips a leading UTF-8 BOM instead of treating the file as corrupt', () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'config.json');
  const bom = '﻿';
  writeFileSync(path, `${bom}{"autoCommit":true}`);
  assert.deepEqual(readConfig(path), {
    exists: true,
    data: { autoCommit: true },
    corrupt: false,
  });
});

test('mergeConfig keeps unrelated keys and unknown gates, overrides known ones', () => {
  const existing = {
    autoCommit: true,
    gates: { oldGate: true, blockX: false },
  };
  const merged = mergeConfig(existing, {
    adopted: 'partial',
    gates: { blockX: true, blockY: false },
    gateVersion: '3.0.0',
  });
  assert.deepEqual(merged, {
    autoCommit: true,
    adopted: 'partial',
    gateVersion: '3.0.0',
    gates: { oldGate: true, blockX: true, blockY: false },
  });
});

test('writeConfig creates parent folders and writes pretty JSON with trailing newline', () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'a', 'b', 'config.json');
  writeConfig(path, { adopted: true });
  assert.ok(existsSync(path));
  assert.equal(readFileSync(path, 'utf8'), '{\n  "adopted": true\n}\n');
});
