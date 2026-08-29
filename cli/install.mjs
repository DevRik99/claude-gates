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

function marketplaceAndPlugin() {
  const manifest = JSON.parse(readFileSync(MARKETPLACE_PATH, 'utf8'));
  const [plugin] = manifest.plugins;
  return { marketplace: manifest.name, plugin: plugin.name };
}

/** The `claude plugin install …` line, read from the manifest, never hard-coded. */
export function pluginInstallCommand() {
  const { marketplace, plugin } = marketplaceAndPlugin();
  return `claude plugin install ${plugin}@${marketplace}`;
}

function claude(commandArguments) {
  return execFileSync(CLAUDE_BIN, commandArguments, {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

/**
 * Registers the marketplace (idempotent: a second add just reports it already exists, which
 * is not fatal) and installs the plugin at the scope matching the config choice.
 * Returns { installed, scope } on success, or { installed:false, reason } to fall back to
 * the printed command.
 */
export function installPlugin(configScope, { cwd = process.cwd() } = {}) {
  const { marketplace, plugin } = marketplaceAndPlugin();
  const scope = PLUGIN_SCOPE[configScope] ?? 'user';

  try {
    try {
      claude([
        'plugin',
        'marketplace',
        'add',
        REPOSITORY_ROOT,
        '--scope',
        'user',
      ]);
    } catch {
      // Already registered, or the marketplace add is a no-op — install can still proceed.
    }
    claude([
      'plugin',
      'install',
      `${plugin}@${marketplace}`,
      '--yes',
      '--scope',
      scope,
    ]);
    return { installed: true, scope };
  } catch (error) {
    const reason =
      error?.code === 'ENOENT'
        ? 'the `claude` command was not found on PATH'
        : (error?.stderr || error?.message || String(error))
            .trim()
            .split('\n')[0];
    return { installed: false, reason, cwd };
  }
}
