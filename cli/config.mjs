// Where the selection is persisted and how it merges with what is already there.
//
// Scope "project": `<project root>/.ai/config.json` — the file the hooks read
//   per project. Other keys the project already has (autoCommit, etc.) are kept.
// Scope "global": `~/.claude/claude-gates/config.json` — the fallback the hooks
//   use when a project has no answer of its own.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findUpSync } from 'find-up';
import {
  CLAUDE_USER_DIRECTORY,
  CONFIG_FILE,
  GLOBAL_STATE_DIRECTORY,
  HOME_DIRECTORY,
  JSON_INDENT,
  PROJECT_ROOT_MARKERS,
  PROJECT_STATE_DIRECTORY,
} from './constants.mjs';

export const SCOPES = Object.freeze({ GLOBAL: 'global', PROJECT: 'project' });

/**
 * Climbs from `startDirectory` to the nearest project marker (`.git`/`.ai`).
 * The home directory (and anything above it) is never a project root: a stray
 * `~/.ai` would otherwise turn every folder under home into "the project" and the
 * config would land in the wrong place silently. `.git` may be a file (worktrees),
 * so the matcher checks existence, not type.
 */
export function findProjectRoot(
  startDirectory,
  { home = HOME_DIRECTORY } = {},
) {
  if (startDirectory === home) return startDirectory;
  const markerDirectory = findUpSync(
    (directory) => {
      if (directory === home) return findUpSync.stop;
      const hasMarker = PROJECT_ROOT_MARKERS.some((marker) =>
        existsSync(join(directory, marker)),
      );
      return hasMarker ? directory : undefined;
    },
    { cwd: startDirectory, stopAt: home, type: 'directory' },
  );
  return markerDirectory ?? startDirectory;
}

export function configPathFor(
  scope,
  { cwd = process.cwd(), home = HOME_DIRECTORY } = {},
) {
  if (scope === SCOPES.GLOBAL)
    return join(
      home,
      CLAUDE_USER_DIRECTORY,
      GLOBAL_STATE_DIRECTORY,
      CONFIG_FILE,
    );
  if (scope === SCOPES.PROJECT)
    return join(
      findProjectRoot(cwd, { home }),
      PROJECT_STATE_DIRECTORY,
      CONFIG_FILE,
    );
  throw new Error(`Unknown scope: ${scope}`);
}

export function readConfig(path) {
  if (!existsSync(path)) return { exists: false, data: {}, corrupt: false };
  try {
    return {
      exists: true,
      data: JSON.parse(readFileSync(path, 'utf8')),
      corrupt: false,
    };
  } catch {
    return { exists: true, data: {}, corrupt: true };
  }
}

/**
 * Merges one gate's new value onto whatever the project already had, preserving the user's
 * edits. A gate with params arrives as `{ enabled, ...defaults }`; if the user already
 * tuned those params, their values win and only `enabled` follows the new selection. A
 * paramless gate is a plain boolean. This is what keeps a re-run of `init` additive: it
 * never overwrites a whitelist or pattern list the user changed by hand.
 */
function mergeGate(existingValue, newValue) {
  if (typeof newValue === 'boolean') return newValue;
  if (existingValue && typeof existingValue === 'object') {
    return { ...newValue, ...existingValue, enabled: newValue.enabled };
  }
  return newValue;
}

/**
 * Merges the new selection into an existing config without touching unrelated keys. Gates
 * are merged key by key: a gate absent from the new map keeps its old value (a registry
 * that dropped a gate must not silently flip it), and a gate the user configured keeps its
 * params (see mergeGate).
 */
export function mergeConfig(existing, { adopted, gates, gateVersion }) {
  const mergedGates = { ...(existing.gates ?? {}) };
  for (const [key, value] of Object.entries(gates)) {
    mergedGates[key] = mergeGate(mergedGates[key], value);
  }
  return { ...existing, adopted, gateVersion, gates: mergedGates };
}

export function writeConfig(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, JSON_INDENT)}\n`, 'utf8');
}
