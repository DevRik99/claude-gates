import { block, runStopHook } from '../../lib/hook-io.mjs';
import {
  CONFIG_KEY,
  DEFAULT_PARAMS,
  GATE_ID,
  engramConfigured,
  readState,
} from './shared.mjs';

runStopHook(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: { ...DEFAULT_PARAMS },
  },
  ({ sessionId, parameters, cwd }) => {
    if (!parameters.requireSaveBeforeStop) return;
    const state = readState(sessionId, cwd);
    if (state.researchCalls === 0) return;
    if (state.lastMemSaveAt >= state.lastResearchAt) return;
    /*
     * With no engram declared there is no `mem_save` to call, so blocking the
     * stop would strand the turn: research already got through (the PreToolUse
     * side degrades to a warning), and demanding a save nothing can perform just
     * moves the same dead end to the end of the turn.
     */
    if (!engramConfigured(parameters, cwd)) return;
    block(
      CONFIG_KEY,
      `This session made ${state.researchCalls} research call(s) (web/context7) and nothing was saved to ` +
        'engram afterwards. Call mem_save with what the research established (What/Why/Where/Learned, ' +
        'or mem_session_summary if it was broad), then end the turn. Research that is not saved is repeated next session.',
    );
  },
);
