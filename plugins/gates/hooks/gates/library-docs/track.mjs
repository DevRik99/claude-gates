import {
  allow,
  mcpActionSegment,
  mcpServerSegment,
  readHookPayload,
  sessionIdOf,
  toolInputOf,
  toolNameOf,
  toolResponseOf,
} from '../../lib/hook-io.mjs';
import {
  CONTEXT7_SERVERS as CONTEXT7_NAMES,
  ENGRAM_SERVERS as ENGRAM_NAMES,
} from '../../lib/mcp-servers.mjs';
import { updateSessionState } from '../../lib/session-state.mjs';

const GATE_ID = 'library-docs';
const ENGRAM_SERVERS = new Set(ENGRAM_NAMES);
const CONTEXT7_SERVERS = new Set(CONTEXT7_NAMES);
const SAVE_ACTIONS = new Set(['mem_save', 'mem_session_summary', 'mem_update']);
const NO_RESULT_PATTERN = /no memories found|no results|0 results/i;
const MAX_ENTRIES = 40;
const MAX_ENTRY_LENGTH = 300;

function textOf(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

function inputText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return [
    toolInput.query,
    toolInput.title,
    toolInput.content,
    toolInput.libraryName,
    toolInput.context7CompatibleLibraryID,
    toolInput.topic,
  ]
    .filter((value) => typeof value === 'string')
    .join(' ');
}

function remember(list, entry) {
  return [...(list ?? []), String(entry).slice(0, MAX_ENTRY_LENGTH)].slice(
    -MAX_ENTRIES,
  );
}

function classify(toolName) {
  const server = mcpServerSegment(toolName).toLowerCase();
  const action = mcpActionSegment(toolName).toLowerCase();
  if (ENGRAM_SERVERS.has(server) && action === 'mem_search') return 'search';
  if (ENGRAM_SERVERS.has(server) && SAVE_ACTIONS.has(action)) return 'save';
  if (CONTEXT7_SERVERS.has(server)) return 'docs';
  return null;
}

function main() {
  const rawPayload = readHookPayload();
  if (rawPayload === null) allow();
  const toolName = toolNameOf(rawPayload) ?? '';
  const kind = classify(toolName);
  if (!kind) allow();
  const toolInput = toolInputOf(rawPayload);
  const response = textOf(toolResponseOf(rawPayload));
  const text = inputText(toolInput);
  updateSessionState(GATE_ID, sessionIdOf(rawPayload), {}, (state) => {
    if (kind === 'search') {
      const hit = response.length > 0 && !NO_RESULT_PATTERN.test(response);
      return hit
        ? {
            ...state,
            memSearchHits: remember(state.memSearchHits, `${text} ${response}`),
          }
        : state;
    }
    if (kind === 'save')
      return { ...state, memSaves: remember(state.memSaves, text) };
    return {
      ...state,
      context7Lookups: remember(
        state.context7Lookups,
        `${text} ${response.slice(0, MAX_ENTRY_LENGTH)}`,
      ),
    };
  });
  allow();
}

try {
  main();
} catch {
  allow();
}
