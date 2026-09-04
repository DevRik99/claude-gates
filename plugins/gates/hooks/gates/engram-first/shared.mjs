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
