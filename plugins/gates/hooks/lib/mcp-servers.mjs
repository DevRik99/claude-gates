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

  const userConfig = readJsonOrNull(join(home, '.claude.json'));
  if (userConfig) {
    known = true;
    names.push(...keysOf(userConfig.mcpServers));
    names.push(...keysOf(userConfig.projects?.[root]?.mcpServers));
  }

  const installedPlugins = readJsonOrNull(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
  );
  if (installedPlugins) {
    known = true;
    names.push(...keysOf(installedPlugins.plugins));
  }

  return { known, names: names.map((name) => String(name).toLowerCase()) };
}

/**
 * Whether any of `candidates` — a gate's server aliases, e.g.
 * ['engram', 'plugin_engram_engram'] — is declared on this machine. True when nothing
 * declares MCP config anywhere, because that is ignorance rather than evidence of absence.
 */
export function mcpServerAvailable(
  candidates,
  root,
  { home = homedir() } = {},
) {
  const key = `${root} ${home}`;
  if (cache?.key !== key) cache = { key, ...declaredMcpNames(root, { home }) };
  if (!cache.known) return true;
  return (candidates ?? []).some((candidate) => {
    const wanted = String(candidate).toLowerCase();
    return (
      wanted.length > 0 &&
      cache.names.some((name) => name === wanted || name.includes(wanted))
    );
  });
}
