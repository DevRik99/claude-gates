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

const BOM_CODE_POINT = 0xfeff;

function stripBom(text) {
  return text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text;
}

function marketplaceManifest() {
  return JSON.parse(stripBom(readFileSync(MARKETPLACE_PATH, 'utf8')));
}

// A marketplace block in `plugin marketplace list` prints a name line (optionally bulleted
// with ❯) then a `Source: <Kind> (<path>)` line. These match one line each — anchored and
// with bounded, non-overlapping character classes so there is no catastrophic backtracking.
const MARKETPLACE_NAME_LINE = /^[^\S\n]*(?:❯[^\S\n]*)?([\w-]+)[^\S\n]*$/;
const MARKETPLACE_DIRECTORY_SOURCE =
  /^[^\S\n]*Source:[^\S\n]*Directory[^\S\n]*\(([^)]+)\)/i;
// A plain loop, not a regex: `/[\\/]+$/` is flagged as super-linear by the linter even
// though this use is bounded and safe, and trimming trailing slashes one character at a
// time from the end needs no backtracking-capable pattern at all.
function trimTrailingSlashes(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '/' || text[end - 1] === '\\')) end -= 1;
  return text.slice(0, end);
}

/**
 * Every registered marketplace as `{ name, source }`, parsed from `plugin marketplace list`.
 * `source` is the directory path a Directory-source marketplace serves from (trailing slash
 * stripped). Only Directory-source marketplaces are returned (GitHub sources have no local
 * path to compare). Empty on any listing failure.
 */
function listRegisteredMarketplaces(runClaude) {
  let listing;
  try {
    listing = runClaude(['plugin', 'marketplace', 'list']);
  } catch {
    return [];
  }
  const marketplaces = [];
  let currentName = null;
  for (const line of listing.split(/\r?\n/)) {
    const nameMatch = MARKETPLACE_NAME_LINE.exec(line);
    if (nameMatch) {
      currentName = nameMatch[1];
      continue;
    }
    const sourceMatch = MARKETPLACE_DIRECTORY_SOURCE.exec(line);
    if (sourceMatch && currentName) {
      marketplaces.push({
        name: currentName,
        source: trimTrailingSlashes(sourceMatch[1]),
      });
      currentName = null;
    }
  }
  return marketplaces;
}

/**
 * The name Claude Code actually registered THIS directory's marketplace under. Usually the
 * manifest's `name`, but not always: if the user added the same directory earlier under a
 * different name (e.g. `devrik`), Claude Code keeps that original registration name, and
 * `plugin marketplace add` is a no-op that does not rename it. Installing as `plugin@<name>`
 * then fails with "not found in marketplace <name>". So we find the registered marketplace
 * whose source path is our REPOSITORY_ROOT and use that name; we fall back to the manifest
 * name when the listing is unavailable (e.g. no `claude` binary).
 */
function registeredMarketplaceName(runClaude, fallbackName) {
  const root = trimTrailingSlashes(REPOSITORY_ROOT);
  const here = listRegisteredMarketplaces(runClaude).find(
    (entry) => entry.source.toLowerCase() === root.toLowerCase(),
  );
  return here ? here.name : fallbackName;
}

/** Every plugin the manifest declares, paired with the marketplace's registered name. */
function marketplaceAndPlugins(runClaude = realClaude) {
  const manifest = marketplaceManifest();
  const marketplace = registeredMarketplaceName(runClaude, manifest.name);
  return manifest.plugins.map((plugin) => ({
    marketplace,
    plugin: plugin.name,
  }));
}

/**
 * A marketplace registered from a DIRECTORY serves whatever version lives at that path. When
 * the user updates the npm package, the new version lands in a NEW location (a fresh npx cache
 * dir, a global install, a cloned repo), but the marketplace still points at the OLD path and
 * `plugin marketplace add` on the new path is a no-op that does NOT re-point it — so Claude
 * Code keeps serving the stale version, and `plugin update` finds nothing newer. This detects
 * that mismatch and re-points the marketplace (remove + add) at THIS running package's root,
 * so an update actually takes effect.
 *
 * It matches the existing registration by NAME (the manifest name, plus any name that already
 * points at a claude-gates package path — resilient to the marketplace having been registered
 * under a different name, the known `devrik` case). No-op when a registration already points
 * here (the common case). Best-effort: any failure is swallowed and the normal add still runs.
 */
function repointMarketplaceIfStale(runClaude, manifestName) {
  const here = trimTrailingSlashes(REPOSITORY_ROOT);
  const registered = listRegisteredMarketplaces(runClaude);
  if (registered.length === 0) return;

  // Already pointing here under any name → nothing to do.
  if (
    registered.some(
      (entry) => entry.source.toLowerCase() === here.toLowerCase(),
    )
  )
    return;

  // A stale registration to re-point: the one named like our manifest, or (fallback) one whose
  // stale source path is itself a claude-gates package directory.
  const stale =
    registered.find((entry) => entry.name === manifestName) ??
    registered.find((entry) =>
      /[\\/]@devrik-tools[\\/]claude-gates$/i.test(entry.source),
    );
  if (!stale) return;

  try {
    runClaude(['plugin', 'marketplace', 'remove', stale.name]);
    runClaude([
      'plugin',
      'marketplace',
      'add',
      REPOSITORY_ROOT,
      '--scope',
      'user',
    ]);
  } catch {
    // Re-pointing failed — non-fatal; the caller's own add attempt still follows.
  }
}

/** The `claude plugin install …` lines, one per plugin the manifest declares. */
export function pluginInstallCommands() {
  return marketplaceAndPlugins().map(
    ({ marketplace, plugin }) =>
      `claude plugin install ${plugin}@${marketplace}`,
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
 * Best-effort removal of a previously installed version of each manifest plugin, at the
 * given scope, before the fresh install runs. `claude plugin uninstall <plugin> --scope
 * <scope>` is verified (via `claude plugin uninstall --help`) to take the bare plugin name
 * (no `@marketplace`, unlike install) and the same `--scope` values as install. When there
 * is no previous install, uninstall fails — that is expected and non-fatal, so failures here
 * are swallowed and never stop the install that follows.
 */
function removePreviousInstalls(targets, scope, runClaude) {
  for (const { plugin } of targets) {
    try {
      runClaude(['plugin', 'uninstall', plugin, '--scope', scope, '--yes']);
    } catch {
      // No previous install (or removal failed for some other reason) — non-fatal either way;
      // the install below is what actually matters.
    }
  }
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
 *
 * `removePrevious` (default true) uninstalls each plugin's previous version at this scope
 * before installing, so a stale version never lingers alongside the new one. It is best-effort
 * and never fails the overall install.
 */
export function installPlugin(
  configScope,
  { cwd = process.cwd(), runClaude = realClaude, removePrevious = true } = {},
) {
  const scope = PLUGIN_SCOPE[configScope] ?? 'user';

  // If a marketplace for our plugins is already registered but points at a STALE location (an
  // older package version in a different npx-cache/global/clone path), re-point it here first
  // — otherwise the add below is a no-op and Claude Code keeps serving the old version. Uses
  // the manifest name to find the existing registration; best-effort, never fatal.
  repointMarketplaceIfStale(runClaude, marketplaceManifest().name);

  try {
    runClaude([
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

  // Resolve the registered marketplace name AFTER the add, so a fresh registration is seen and
  // a pre-existing one (under any name) is matched by its source path. Doing it here, not at
  // module top, means the name reflects the live registration this run just ensured.
  const targets = marketplaceAndPlugins(runClaude);

  if (removePrevious) removePreviousInstalls(targets, scope, runClaude);

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
    reason: failed
      .map((result) => `${result.plugin}: ${result.reason}`)
      .join('; '),
    cwd,
  };
}
