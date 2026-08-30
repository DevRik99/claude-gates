// Installs the gates plugin into Claude Code from the selection `init` just wrote.
// Additive by design: `claude plugin install` merges the plugin's hooks alongside whatever
// the user already has — it never rewrites their settings. If the `claude` binary is not
// reachable, this degrades to printing the manual command, and `init` still succeeds.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SCOPES } from './config.mjs';
import { MARKETPLACE_PATH, REPOSITORY_ROOT } from './constants.mjs';

const CLAUDE_BIN = 'claude';

// Config scope decides where the plugin is installed: a project selection stays local to
// this project (its .claude/settings.json); a global selection installs for every project.
const PLUGIN_SCOPE = Object.freeze({
  [SCOPES.PROJECT]: 'project',
  [SCOPES.GLOBAL]: 'user',
});

function marketplaceManifest() {
  return JSON.parse(readFileSync(MARKETPLACE_PATH, 'utf8'));
}

/** Every plugin the marketplace declares: { marketplace, plugin } pairs, in manifest order. */
function marketplaceAndPlugins() {
  const manifest = marketplaceManifest();
  return manifest.plugins.map((plugin) => ({
    marketplace: manifest.name,
    plugin: plugin.name,
  }));
}

/** The `claude plugin install …` lines, one per plugin the manifest declares. */
export function pluginInstallCommands() {
  return marketplaceAndPlugins().map(
    ({ marketplace, plugin }) => `claude plugin install ${plugin}@${marketplace}`,
  );
}

/** Back-compat single-line form: the first plugin's install command. */
export function pluginInstallCommand() {
  return pluginInstallCommands()[0];
}

function realClaude(commandArguments) {
  return execFileSync(CLAUDE_BIN, commandArguments, {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function reasonFor(error) {
  return error?.code === 'ENOENT'
    ? 'the `claude` command was not found on PATH'
    : (error?.stderr || error?.message || String(error)).trim().split('\n')[0];
}

/**
 * Registers the marketplace (idempotent: a second add just reports it already exists, which
 * is not fatal) once, then installs EVERY plugin the manifest declares at the scope matching
 * the config choice. A project that adopts claude-gates gets all of its plugins (gates,
 * tasks, …), not just the first — a single failed install does not stop the rest from being
 * attempted, so one broken plugin never silently blocks another that would have worked.
 *
 * Returns { installed, scope, results } where `installed` is true only if every plugin
 * installed; `results` is a per-plugin { plugin, installed, reason? } list so a caller can
 * report exactly which ones need the manual command.
 *
 * `runClaude` is an injectable seam (defaults to the real `claude` binary) so tests can
 * exercise the multi-plugin partial-failure logic without actually invoking the CLI and
 * installing plugins on the machine running the test.
 */
export function installPlugin(
  configScope,
  { cwd = process.cwd(), runClaude = realClaude } = {},
) {
  const targets = marketplaceAndPlugins();
  const scope = PLUGIN_SCOPE[configScope] ?? 'user';

  try {
    runClaude(['plugin', 'marketplace', 'add', REPOSITORY_ROOT, '--scope', 'user']);
  } catch {
    // Already registered, or the marketplace add is a no-op — install can still proceed.
  }

  const results = targets.map(({ marketplace, plugin }) => {
    try {
      runClaude([
        'plugin',
        'install',
        `${plugin}@${marketplace}`,
        '--yes',
        '--scope',
        scope,
      ]);
      return { plugin, installed: true };
    } catch (error) {
      return { plugin, installed: false, reason: reasonFor(error) };
    }
  });

  const installed = results.every((result) => result.installed);
  if (installed) return { installed: true, scope, results };

  const failed = results.filter((result) => !result.installed);
  return {
    installed: false,
    scope,
    results,
    reason: failed.map((result) => `${result.plugin}: ${result.reason}`).join('; '),
    cwd,
  };
}
