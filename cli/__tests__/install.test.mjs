// installPlugin used to install only the marketplace's FIRST plugin (`const [plugin] =
// manifest.plugins`), so a second plugin (like `tasks`) never got installed by `init`. These
// tests exercise the fixed multi-plugin behavior with a fake `runClaude` — never the real
// `claude` binary, which would actually install plugins on the machine running the test.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCOPES } from '../config.mjs';
import { REPOSITORY_ROOT } from '../constants.mjs';
import { installPlugin, pluginInstallCommands } from '../install.mjs';

// A stale package path (different from REPOSITORY_ROOT) whose tail is the claude-gates package
// dir — built from the temp dir so it carries no hard-coded absolute literal.
const STALE_PACKAGE_PATH = join(
  tmpdir(),
  'npx-cache',
  'node_modules',
  '@devrik-tools',
  'claude-gates',
);

test('pluginInstallCommands lists one command per plugin the marketplace declares (gates AND tasks)', () => {
  const commands = pluginInstallCommands();
  assert.ok(
    commands.some((command) => command.includes('install gates@')),
    'gates must still be installable',
  );
  assert.ok(
    commands.some((command) => command.includes('install tasks@')),
    'tasks must now be installable too — this was the whole point of the fix',
  );
});

test('installPlugin installs EVERY plugin, not just the first', () => {
  const invocations = [];
  const runClaude = (arguments_) => {
    invocations.push(arguments_);
    return '';
  };

  const result = installPlugin(SCOPES.PROJECT, {
    cwd: REPOSITORY_ROOT,
    runClaude,
  });

  assert.equal(result.installed, true);
  const installedPlugins = result.results.map((entry) => entry.plugin);
  assert.ok(installedPlugins.includes('gates'));
  assert.ok(installedPlugins.includes('tasks'));
  assert.equal(
    result.results.every((entry) => entry.installed),
    true,
  );

  // One marketplace add + one install call per plugin.
  const installCalls = invocations.filter(
    (arguments_) => arguments_[1] === 'install',
  );
  assert.equal(installCalls.length, result.results.length);
});

test('installPlugin: one plugin failing does not stop the rest from being attempted', () => {
  const runClaude = (arguments_) => {
    if (
      arguments_[0] === 'plugin' &&
      arguments_[1] === 'install' &&
      arguments_[2].startsWith('gates@')
    ) {
      throw new Error('boom: gates install failed');
    }
    return '';
  };

  const result = installPlugin(SCOPES.GLOBAL, {
    cwd: REPOSITORY_ROOT,
    runClaude,
  });

  assert.equal(
    result.installed,
    false,
    'overall result reflects the partial failure',
  );
  const gatesEntry = result.results.find((entry) => entry.plugin === 'gates');
  const tasksEntry = result.results.find((entry) => entry.plugin === 'tasks');
  assert.equal(gatesEntry.installed, false);
  assert.match(gatesEntry.reason, /boom/);
  assert.equal(
    tasksEntry.installed,
    true,
    'tasks must still install even though gates failed',
  );
  assert.match(result.reason, /gates/);
});

test('installPlugin uses the marketplace name Claude Code actually registered, not the manifest name', () => {
  // The repo's manifest name is `claude-gates`, but if the user added this same directory
  // earlier under a different name, Claude Code keeps that name. installPlugin must install as
  // plugin@<registered-name>, or `claude` answers "not found in marketplace claude-gates".
  const installCalls = [];
  const runClaude = (arguments_) => {
    if (arguments_[1] === 'marketplace' && arguments_[2] === 'list') {
      // A listing where THIS repo is registered under the name `devrik`.
      return `Configured marketplaces:\n\n  ❯ devrik\n    Source: Directory (${REPOSITORY_ROOT})\n`;
    }
    if (arguments_[1] === 'install') installCalls.push(arguments_[2]);
    return '';
  };

  const result = installPlugin(SCOPES.GLOBAL, {
    cwd: REPOSITORY_ROOT,
    runClaude,
  });

  assert.equal(result.installed, true);
  assert.ok(
    installCalls.every((target) => target.endsWith('@devrik')),
    `every install must target @devrik, got: ${installCalls.join(', ')}`,
  );
});

test('installPlugin re-points a stale marketplace (old path) at this package before installing', () => {
  // The marketplace `claude-gates` is registered pointing at an OLD npx-cache path, not this
  // running package. installPlugin must remove that stale registration and re-add THIS root,
  // so Claude Code serves the current version instead of the stale one.
  const calls = [];
  const runClaude = (arguments_) => {
    calls.push(arguments_);
    if (arguments_[1] === 'marketplace' && arguments_[2] === 'list') {
      return `Configured marketplaces:\n\n  ❯ claude-gates\n    Source: Directory (${STALE_PACKAGE_PATH})\n`;
    }
    return '';
  };

  installPlugin(SCOPES.GLOBAL, { cwd: REPOSITORY_ROOT, runClaude });

  const removed = calls.find(
    (arguments_) =>
      arguments_[1] === 'marketplace' && arguments_[2] === 'remove',
  );
  assert.ok(removed, 'a stale marketplace must be removed');
  assert.equal(
    removed[3],
    'claude-gates',
    'the stale registration is removed by name',
  );
  const reAddedCall = calls.find(
    (arguments_) =>
      arguments_[1] === 'marketplace' &&
      arguments_[2] === 'add' &&
      arguments_[3] === REPOSITORY_ROOT,
  );
  assert.ok(
    reAddedCall,
    'the marketplace must be re-added pointing at this package root',
  );
});

test('installPlugin does NOT re-point a marketplace that already points here', () => {
  const calls = [];
  const runClaude = (arguments_) => {
    calls.push(arguments_);
    if (arguments_[1] === 'marketplace' && arguments_[2] === 'list') {
      return `Configured marketplaces:\n\n  ❯ claude-gates\n    Source: Directory (${REPOSITORY_ROOT})\n`;
    }
    return '';
  };

  installPlugin(SCOPES.GLOBAL, { cwd: REPOSITORY_ROOT, runClaude });

  const removed = calls.find(
    (arguments_) =>
      arguments_[1] === 'marketplace' && arguments_[2] === 'remove',
  );
  assert.equal(
    removed,
    undefined,
    'no removal when the registration is already current',
  );
});

test('installPlugin re-points a stale marketplace registered under a different name (devrik)', () => {
  // Registered under a name that is NOT the manifest name, pointing at a stale claude-gates
  // path — matched by its package-dir tail, not its name.
  const calls = [];
  const runClaude = (arguments_) => {
    calls.push(arguments_);
    if (arguments_[1] === 'marketplace' && arguments_[2] === 'list') {
      return `Configured marketplaces:\n\n  ❯ legacy-name\n    Source: Directory (${STALE_PACKAGE_PATH})\n`;
    }
    return '';
  };

  installPlugin(SCOPES.GLOBAL, { cwd: REPOSITORY_ROOT, runClaude });

  const removed = calls.find(
    (arguments_) =>
      arguments_[1] === 'marketplace' && arguments_[2] === 'remove',
  );
  assert.ok(
    removed,
    'a stale registration under any name is matched by its claude-gates path',
  );
  assert.equal(removed[3], 'legacy-name');
});

test('installPlugin degrades gracefully when the claude binary is entirely unreachable', () => {
  const runClaude = () => {
    const error = new Error('spawn claude ENOENT');
    error.code = 'ENOENT';
    throw error;
  };

  const result = installPlugin(SCOPES.PROJECT, {
    cwd: REPOSITORY_ROOT,
    runClaude,
  });

  assert.equal(result.installed, false);
  assert.ok(result.results.every((entry) => !entry.installed));
  assert.ok(
    result.results.every((entry) => /not found on PATH/.test(entry.reason)),
  );
});
