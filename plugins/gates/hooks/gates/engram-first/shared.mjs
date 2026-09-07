import { join } from 'node:path';
import { readJsonOrNull } from '../../lib/config.mjs';
import {
  mcpActionSegment,
  mcpServerSegment,
  toolInGroups,
} from '../../lib/hook-io.mjs';
import {
  readSessionState,
  writeSessionState,
} from '../../lib/session-state.mjs';

export const GATE_ID = 'engram-first';
export const CONFIG_KEY = 'requireEngramBeforeResearch';

export const DEFAULT_PARAMS = Object.freeze({
  engramServers: ['engram', 'plugin_engram_engram'],
  context7Servers: ['context7', 'plugin_context7_context7'],
  researchTools: ['WebSearch', 'WebFetch'],
  engramUrl: 'http://127.0.0.1:7437',
  requireSaveBeforeStop: true,
});

const MAX_RECORDED_QUERIES = 30;
const MAX_QUERY_LENGTH = 200;

export const EMPTY_STATE = Object.freeze({
  memSearchCount: 0,
  memSearchHits: 0,
  memSearchQueries: [],
  memSaveCount: 0,
  researchCalls: 0,
  lastResearchAt: 0,
  lastMemSaveAt: 0,
});

/**
 * Mirrors the normalization the tool namespace applies, because a server
 * configured as `Engram AI` reaches transcripts as `engram_ai`: matching the
 * raw configured name would miss it.
 */
function normalizeServerName(name) {
  return String(name)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '_');
}

function serverMatches(toolName, servers) {
  const server = mcpServerSegment(String(toolName ?? '')).toLowerCase();
  return servers.some((name) => String(name).toLowerCase() === server);
}

export function isEngramTool(toolName, parameters) {
  return serverMatches(toolName, parameters.engramServers);
}

export function isContext7Tool(toolName, parameters) {
  return serverMatches(toolName, parameters.context7Servers);
}

export function isResearchTool(toolName, parameters) {
  if (isEngramTool(toolName, parameters)) return false;
  const lowered = String(toolName ?? '').toLowerCase();
  if (parameters.researchTools.some((name) => name.toLowerCase() === lowered))
    return true;
  if (isContext7Tool(toolName, parameters)) return true;
  return toolInGroups(toolName, ['research']);
}

export function engramActionOf(toolName) {
  return mcpActionSegment(String(toolName ?? '')).toLowerCase();
}

export function readState(sessionId, cwd) {
  return {
    ...EMPTY_STATE,
    ...readSessionState(GATE_ID, sessionId, {}, { cwd }),
  };
}

export function writeState(sessionId, state, cwd) {
  return writeSessionState(GATE_ID, sessionId, state, { cwd });
}

export function rememberQuery(state, query) {
  const queries = [
    ...state.memSearchQueries,
    String(query ?? '').slice(0, MAX_QUERY_LENGTH),
  ];
  return queries.slice(-MAX_RECORDED_QUERIES);
}

function declaredMcpServerNames(cwd) {
  const names = [];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  const userConfig = readJsonOrNull(join(home, '.claude.json'));
  if (userConfig) {
    names.push(...Object.keys(userConfig.mcpServers ?? {}));
    for (const project of Object.values(userConfig.projects ?? {})) {
      names.push(...Object.keys(project?.mcpServers ?? {}));
    }
  }

  const projectConfig = readJsonOrNull(join(String(cwd ?? '.'), '.mcp.json'));
  if (projectConfig) {
    names.push(...Object.keys(projectConfig.mcpServers ?? {}));
  }

  return names;
}

/**
 * A gate whose precondition cannot be satisfied must not block: with no engram
 * server declared anywhere, `mem_search` does not exist as a tool, so denying
 * research closes a loop with no exit. Same stance as forge-flow, which warns
 * and allows when its DB cannot be read.
 *
 * Declaration and not reachability, because a network probe is the wrong
 * instrument: it costs a timeout on every research call, and under process
 * sandboxing a child cannot reach even a server that is running, so a live
 * engram would read as absent. Whether it is DECLARED separates the case where
 * nothing can be called (allow) from the case where it is merely stopped, which
 * the deny message already tells the user how to fix.
 */
export function engramConfigured(parameters, cwd) {
  const wanted = new Set(
    (parameters.engramServers ?? []).map((name) => String(name).toLowerCase()),
  );
  if (wanted.size === 0) return false;

  return declaredMcpServerNames(cwd).some((name) =>
    wanted.has(normalizeServerName(name)),
  );
}

export function queryOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(
    toolInput.query ??
      toolInput.title ??
      toolInput.libraryName ??
      toolInput.prompt ??
      toolInput.url ??
      '',
  );
}
