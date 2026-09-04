import { gateParameters, isGateEnabled } from '../../lib/config.mjs';
import {
  allow,
  coerceParameters,
  readHookPayload,
  sessionIdOf,
  toolInputOf,
  toolNameOf,
  toolResponseOf,
} from '../../lib/hook-io.mjs';
import {
  CONFIG_KEY,
  DEFAULT_PARAMS,
  engramActionOf,
  isEngramTool,
  isResearchTool,
  queryOf,
  readState,
  rememberQuery,
  writeState,
} from './shared.mjs';

const SAVE_ACTIONS = new Set(['mem_save', 'mem_session_summary', 'mem_update']);
const NO_RESULT_PATTERN = /no memories found|no results|0 results/i;

function responseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  try {
    return JSON.stringify(toolResponse ?? '');
  } catch {
    return '';
  }
}

function searchHit(toolResponse) {
  const text = responseText(toolResponse);
  return text.length > 0 && !NO_RESULT_PATTERN.test(text);
}

function nextState(state, { toolName, toolInput, toolResponse, parameters }) {
  const now = Date.now();
  if (isEngramTool(toolName, parameters)) {
    const action = engramActionOf(toolName);
    if (action === 'mem_search') {
      return {
        ...state,
        memSearchCount: state.memSearchCount + 1,
        memSearchHits: state.memSearchHits + (searchHit(toolResponse) ? 1 : 0),
        memSearchQueries: rememberQuery(state, queryOf(toolInput)),
      };
    }
    if (SAVE_ACTIONS.has(action)) {
      return {
        ...state,
        memSaveCount: state.memSaveCount + 1,
        lastMemSaveAt: now,
      };
    }
    return state;
  }
  if (isResearchTool(toolName, parameters)) {
    return {
      ...state,
      researchCalls: state.researchCalls + 1,
      lastResearchAt: now,
    };
  }
  return state;
}

function main() {
  const rawPayload = readHookPayload();
  if (rawPayload === null) allow();
  const cwd = process.cwd();
  if (!isGateEnabled(CONFIG_KEY, true, cwd)) allow();
  const { parameters } = coerceParameters(
    DEFAULT_PARAMS,
    gateParameters(CONFIG_KEY, cwd),
  );
  const sessionId = sessionIdOf(rawPayload);
  const context = {
    toolName: toolNameOf(rawPayload) ?? '',
    toolInput: toolInputOf(rawPayload),
    toolResponse: toolResponseOf(rawPayload),
    parameters,
  };
  const state = readState(sessionId, cwd);
  const updated = nextState(state, context);
  if (updated !== state) writeState(sessionId, updated, cwd);
  allow();
}

try {
  main();
} catch {
  allow();
}
