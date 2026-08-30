// Runtime gate configuration for the hooks. Self-contained: Node built-ins only, no npm,
// so it works when the plugin is installed on its own.
//
// This is the READER the gates use at runtime. The CLI (`cli/config.mjs`) is the WRITER;
// the two never import each other. Both agree on the file: `<project root>/.ai/config.json`,
// with `~/.claude/claude-gates/config.json` as the global fallback.
//
// ── Two things a project controls per gate ──────────────────────────────────────────
//   1. enabled — is the gate on? A gate absent from config keeps the registry default.
//   2. params  — how the gate behaves: its whitelist, its patterns, its watched paths.
//      A param the project declares REPLACES the gate's built-in default wholesale (it
//      does not merge). The gate ships its defaults in its own source so the user can
//      read them and know exactly what to override.
//
// ── Config shape a project may write ────────────────────────────────────────────────
//   "gates": {
//     "blockDestructiveShellCommands": true,                  // shorthand: enabled only
//     "blockWritesToProtectedPaths": { "enabled": true, "protectedPaths": ["...","..."] }
//   }
// A bare boolean is the enabled-only shorthand the CLI writes today; an object carries
// enabled plus any params. Both are accepted so an old plain config keeps working.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CLAUDE_USER_DIRECTORY = '.claude';
const GLOBAL_STATE_DIRECTORY = 'claude-gates';
const PROJECT_STATE_DIRECTORY = '.ai';
const CONFIG_FILE = 'config.json';
// Markers that identify a project root while climbing. Both `.git` AND `.ai/` count — the
// same set the CLI uses — so a repo-less project (no git yet) still gets its project config
// read. Anchoring on `.git` alone silently dropped the project layer in such repos.
const PROJECT_ROOT_MARKERS = ['.git', PROJECT_STATE_DIRECTORY];

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    // Strip a UTF-8 BOM (﻿) before parsing. `readFileSync(path,'utf8')` does NOT remove
    // it, and JSON.parse throws on a leading BOM — so a config saved by a Windows editor or by
    // PowerShell 5.1's `Set-Content -Encoding utf8` (which prepends a BOM) would be read as
    // unparseable, treated as absent, and SILENTLY DROP every gate disable in it. That is the
    // opposite of safe: it re-enables protections the project turned off, and (worse for the
    // symmetric case) means a project can't be trusted to have been read at all. Removing the
    // BOM makes the common Windows round-trip parse correctly.
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch {
    // A genuinely corrupt project config must not silently disable protection: treat it as
    // absent, which falls through to the global config and then to the registry defaults.
    return null;
  }
}

/** Climbs to the nearest project root (a dir holding `.git` or `.ai/`); null when none. */
function projectRootOf(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (
      PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function projectConfigPath(startDirectory) {
  const root = projectRootOf(startDirectory);
  if (!root) return null;
  return join(root, PROJECT_STATE_DIRECTORY, CONFIG_FILE);
}

function globalConfigPath(home) {
  return join(home, CLAUDE_USER_DIRECTORY, GLOBAL_STATE_DIRECTORY, CONFIG_FILE);
}

/**
 * The `gates` object from the first config that exists: project first, then global.
 * A project config that exists but lacks a `gates` key still wins (an empty object) —
 * declaring a config is a deliberate act, and falling through to global would silently
 * re-enable what the project meant to turn off.
 */
function gatesLayerFor(startDirectory, home) {
  const projectPath = projectConfigPath(startDirectory);
  const projectData = projectPath ? readJsonOrNull(projectPath) : null;
  if (projectData) return projectData.gates ?? {};

  const globalData = readJsonOrNull(globalConfigPath(home));
  if (globalData) return globalData.gates ?? {};

  return null; // nothing declared anywhere: gates fall back to registry defaults
}

/** Normalizes a gate's config entry (bool shorthand or object) to a plain object. */
function gateEntryOf(gatesLayer, configKey) {
  if (!gatesLayer) return null;
  const entry = gatesLayer[configKey];
  if (entry === undefined) return null;
  if (typeof entry === 'boolean') return { enabled: entry };
  if (entry && typeof entry === 'object') return entry;
  return null; // malformed (string/number/null): ignore, fall back to default
}

/**
 * Reads the gates layer once per dispatcher invocation and hands back a lookup the
 * dispatcher and gates share. Reading once matters: N gates in the same tool call must
 * not each re-read and re-parse the file.
 *
 * @param {string} startDirectory usually process.cwd()
 * @returns {{ isEnabled(configKey, registryDefault): boolean,
 *             paramsFor(configKey): object }}
 */
export function loadGateConfig(startDirectory, { home = homedir() } = {}) {
  const gatesLayer = gatesLayerFor(startDirectory, home);

  return {
    /**
     * A gate runs unless a config explicitly turns it off. `enabled` absent means "use
     * the registry default"; only an explicit `false` disables. When no config exists
     * anywhere, the registry default decides.
     */
    isEnabled(configKey, registryDefault) {
      const entry = gateEntryOf(gatesLayer, configKey);
      if (!entry || entry.enabled === undefined) return registryDefault;
      return entry.enabled !== false;
    },

    /**
     * The project's params for a gate (everything except `enabled`), or an empty object
     * when none are declared. The gate merges these over its own built-in defaults —
     * a declared param replaces the corresponding default wholesale.
     */
    paramsFor(configKey) {
      const entry = gateEntryOf(gatesLayer, configKey);
      if (!entry) return {};
      const parameters = { ...entry };
      delete parameters.enabled;
      return parameters;
    },
  };
}

/**
 * Whether a gate should run, standalone. `registryDefault` decides when the project (and
 * global) config is silent about this gate; only an explicit `enabled: false` turns a gate
 * off. Used by `runGate` at each gate's start.
 */
export function isGateEnabled(
  configKey,
  registryDefault,
  startDirectory,
  { home = homedir() } = {},
) {
  return loadGateConfig(startDirectory, { home }).isEnabled(
    configKey,
    registryDefault,
  );
}

/**
 * A single gate's project params (its whitelist/patterns), standalone. Returns {} when
 * nothing is declared, so the gate falls back to its own built-in defaults.
 */
export function gateParameters(
  configKey,
  startDirectory,
  { home = homedir() } = {},
) {
  return loadGateConfig(startDirectory, { home }).paramsFor(configKey);
}
