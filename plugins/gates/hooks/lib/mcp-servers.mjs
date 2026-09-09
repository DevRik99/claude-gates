// mcp-servers.mjs — which MCP servers this machine actually declares. A gate that demands
// a tool (engram, context7) must not deny when that tool is not installed: the agent would
// have no way to comply and every research call would dead-end. Absence only counts when a
// config source exists to be absent from — no source at all means "cannot tell", and the
// gate keeps its normal behavior instead of silently switching itself off.
//
// no existing tool covers this: the Claude Code CLI has no offline "list my MCP servers"
// call a PreToolUse hook can afford, so the config files it reads are read directly.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJsonOrNull } from './config.mjs';

export const ENGRAM_SERVERS = Object.freeze(['engram', 'plugin_engram_engram']);
export const CONTEXT7_SERVERS = Object.freeze([
  'context7',
  'plugin_context7_context7',
]);

let cache = null;

function keysOf(value) {
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

/**
 * Mirrors the normalization the tool namespace applies, because a server configured as
 * `Engram AI` reaches transcripts as `engram_ai`: matching the raw configured name misses it.
 */
function normalizeServerName(name) {
  return String(name)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '_');
}

/**
 * Every MCP server and plugin name declared where Claude Code reads them from, plus
 * whether any of those sources existed at all. Plugin names count: a plugin can ship its
 * own server, exposed as plugin_<plugin>_<server>.
 *
 * @returns {{ known: boolean, names: string[] }}
 */
export function declaredMcpNames(root, { home = homedir() } = {}) {
  const names = [];
  let known = false;

  const projectServers = readJsonOrNull(join(root, '.mcp.json'));
  if (projectServers) {
    known = true;
    names.push(...keysOf(projectServers.mcpServers));
  }

  // Every project's servers, not just this root's, because the key is the path as the
  // session opened it and a near-miss there would read as "not installed".
  const userConfig = readJsonOrNull(join(home, '.claude.json'));
  if (userConfig) {
    known = true;
    names.push(...keysOf(userConfig.mcpServers));
    for (const project of Object.values(userConfig.projects ?? {}))
      names.push(...keysOf(project?.mcpServers));
  }

  const installedPlugins = readJsonOrNull(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
  );
  if (installedPlugins) {
    known = true;
    names.push(...keysOf(installedPlugins.plugins));
  }

  return { known, names: names.map(normalizeServerName) };
}

/**
 * Whether any of `candidates` — a gate's server aliases, e.g.
 * ['engram', 'plugin_engram_engram'] — is declared on this machine.
 *
 * Undeclared counts as absent even when no config source was found at all, because the two
 * error directions are not symmetric: guessing "installed" puts the agent back in the
 * no-exit loop these gates exist to avoid, while guessing "absent" only relaxes a policy,
 * and the callers say so out loud instead of going quiet.
 */
export function mcpServerAvailable(
  candidates,
  root,
  { home = homedir() } = {},
) {
  const key = `${root} ${home}`;
  if (cache?.key !== key) cache = { key, ...declaredMcpNames(root, { home }) };
  return (candidates ?? []).some((candidate) => {
    const wanted = normalizeServerName(candidate);
    return (
      wanted.length > 0 &&
      cache.names.some((name) => name === wanted || name.includes(wanted))
    );
  });
}
