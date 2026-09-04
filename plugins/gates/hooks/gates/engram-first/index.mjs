import { deny, runGate } from '../../lib/hook-io.mjs';
import {
  DEFAULT_PARAMS,
  GATE_ID,
  isResearchTool,
  queryOf,
  readState,
} from './shared.mjs';

const CONFIG_KEY = 'requireEngramBeforeResearch';

const TOPIC_EXCERPT_LENGTH = 80;

function denyResearchWithoutMemory(toolName, toolInput) {
  const topic = queryOf(toolInput);
  const suggestion = topic
    ? ` (e.g. mem_search "${topic.slice(0, TOPIC_EXCERPT_LENGTH)}")`
    : '';
  deny(
    CONFIG_KEY,
    `${toolName} was called before any engram lookup in this session. Persistent memory is the ` +
      `first source: call mem_search with the topic you are about to research${suggestion}. ` +
      'If it returns nothing, research with context7 (libraries) or the web, then mem_save what ' +
      'you learned before ending the turn.',
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: { ...DEFAULT_PARAMS },
  },
  ({ toolName, toolInput, sessionId, parameters, cwd }) => {
    if (!isResearchTool(toolName, parameters)) return;
    const state = readState(sessionId, cwd);
    if (state.memSearchCount > 0) return;
    denyResearchWithoutMemory(toolName, toolInput);
  },
);
