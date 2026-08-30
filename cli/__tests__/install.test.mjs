// installPlugin used to install only the marketplace's FIRST plugin (`const [plugin] =
// manifest.plugins`), so a second plugin (like `tasks`) never got installed by `init`. These
// tests exercise the fixed multi-plugin behavior with a fake `runClaude` — never the real
// `claude` binary, which would actually install plugins on the machine running the test.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCOPES } from '../config.mjs';
import { installPlugin, pluginInstallCommands } from '../install.mjs';
import { REPOSITORY_ROOT } from '../constants.mjs';

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
  const runClaude = (args) => {
    invocations.push(args);
    return '';
  };

  const result = installPlugin(SCOPES.PROJECT, { cwd: REPOSITORY_ROOT, runClaude });

  assert.equal(result.installed, true);
  const installedPlugins = result.results.map((entry) => entry.plugin);
  assert.ok(installedPlugins.includes('gates'));
  assert.ok(installedPlugins.includes('tasks'));
  assert.equal(result.results.every((entry) => entry.installed), true);

  // One marketplace add + one install call per plugin.
  const installCalls = invocations.filter((args) => args[1] === 'install');
  assert.equal(installCalls.length, result.results.length);
});

test('installPlugin: one plugin failing does not stop the rest from being attempted', () => {
  const runClaude = (args) => {
    if (args[0] === 'plugin' && args[1] === 'install' && args[2].startsWith('gates@')) {
      throw new Error('boom: gates install failed');
    }
    return '';
  };

  const result = installPlugin(SCOPES.GLOBAL, { cwd: REPOSITORY_ROOT, runClaude });

  assert.equal(result.installed, false, 'overall result reflects the partial failure');
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
  const runClaude = (args) => {
    if (args[1] === 'marketplace' && args[2] === 'list') {
      // A listing where THIS repo is registered under the name `devrik`.
      return `Configured marketplaces:\n\n  ❯ devrik\n    Source: Directory (${REPOSITORY_ROOT})\n`;
    }
    if (args[1] === 'install') installCalls.push(args[2]);
    return '';
  };

  const result = installPlugin(SCOPES.GLOBAL, { cwd: REPOSITORY_ROOT, runClaude });

  assert.equal(result.installed, true);
  assert.ok(
    installCalls.every((target) => target.endsWith('@devrik')),
    `every install must target @devrik, got: ${installCalls.join(', ')}`,
  );
});

test('installPlugin degrades gracefully when the claude binary is entirely unreachable', () => {
  const runClaude = () => {
    const error = new Error('spawn claude ENOENT');
    error.code = 'ENOENT';
    throw error;
  };

  const result = installPlugin(SCOPES.PROJECT, { cwd: REPOSITORY_ROOT, runClaude });

  assert.equal(result.installed, false);
  assert.ok(result.results.every((entry) => !entry.installed));
  assert.ok(result.results.every((entry) => /not found on PATH/.test(entry.reason)));
});
