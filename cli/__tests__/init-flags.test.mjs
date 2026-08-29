import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeOptions } from '../init.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');

test('normalizeOptions maps commander options', () => {
  assert.deepEqual(
    normalizeOptions({
      global: true,
      families: ['security', 'quality'],
      yes: true,
      dryRun: true,
    }),
    {
      scope: 'global',
      mode: 'families',
      families: ['security', 'quality'],
      gates: [],
      yes: true,
      dryRun: true,
      install: undefined,
    },
  );
  assert.equal(normalizeOptions({ gates: ['bash-commands'] }).mode, 'granular');
  assert.equal(normalizeOptions({}).mode, null);
  assert.throws(() => normalizeOptions({ all: true, none: true }), /Pick one/);
  assert.throws(
    () => normalizeOptions({ project: true, global: true }),
    /Pick one/,
  );
});

test('non-interactive init writes .ai/config.json at the project root', () => {
  const project = mkdtempSync(join(tmpdir(), 'claude-gates-proj-'));
  mkdirSync(join(project, '.git'));
  const nested = join(project, 'src');
  mkdirSync(nested);

  execFileSync(
    process.execPath,
    [
      CLI,
      'init',
      '--project',
      '--families',
      'security',
      '--yes',
      '--no-install',
    ],
    { cwd: nested, encoding: 'utf8' },
  );

  const path = join(project, '.ai', 'config.json');
  assert.ok(existsSync(path), 'config written at git root, not at cwd');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.adopted, 'partial');
  // Gates with params are materialized as { enabled, ...defaults } so the knobs are editable.
  assert.equal(config.gates.blockDestructiveShellCommands.enabled, true);
  assert.equal(config.gates.requireBriefBeforeDelegating.enabled, false);
  assert.match(config.gateVersion, /^\d+\.\d+\.\d+$/);
});

test('--dry-run writes nothing', () => {
  const project = mkdtempSync(join(tmpdir(), 'claude-gates-dry-'));
  execFileSync(
    process.execPath,
    [CLI, 'init', '--project', '--all', '--yes', '--dry-run'],
    { cwd: project, encoding: 'utf8' },
  );
  assert.ok(!existsSync(join(project, '.ai', 'config.json')));
});

test('--none records an explicit refusal', () => {
  const project = mkdtempSync(join(tmpdir(), 'claude-gates-none-'));
  execFileSync(
    process.execPath,
    [CLI, 'init', '--project', '--none', '--yes', '--no-install'],
    { cwd: project, encoding: 'utf8' },
  );
  const config = JSON.parse(
    readFileSync(join(project, '.ai', 'config.json'), 'utf8'),
  );
  assert.equal(config.adopted, false);
});

test('a corrupt existing config aborts without writing', () => {
  const project = mkdtempSync(join(tmpdir(), 'claude-gates-corrupt-'));
  mkdirSync(join(project, '.ai'));
  const path = join(project, '.ai', 'config.json');
  writeFileSync(path, '{broken');
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [CLI, 'init', '--project', '--all', '--yes'],
      { cwd: project, encoding: 'utf8', stdio: 'pipe' },
    ),
  );
  assert.equal(readFileSync(path, 'utf8'), '{broken');
});
