// agent-context — WHO made this tool call: the main agent, or a subagent running in a
// sidechain. A gate that must keep the main agent out of the code (delegation enforcement)
// cannot answer that from the tool name or the session id — both are identical either way.
//
// Reuse check: no existing helper covers this. hook-io.mjs reads the tool name, input and
// session id but never the caller's identity. delegation.mjs reads the subagent type out of a
// delegation's own payload — that is who is ABOUT to be launched, the opposite question from
// who is calling at this moment. Only no-reconfirm touches transcript_path, and it does so to
// read the conversation, not to classify the caller.
//
// Claude Code answers it in the transcript layout it writes:
//
//   <projects>/<project>/<session-id>.jsonl                      ← the main agent
//   <projects>/<project>/<session-id>/subagents/agent-<id>.jsonl ← a subagent (isSidechain)
//
// The PreToolUse payload carries that path as transcript_path, so the SHAPE of the path is
// the whole answer — no need to open and parse the transcript on every call. That matters: a
// hook runs per tool call, and reading a growing JSONL file each time would be a real cost.
//
// Three-valued on purpose. UNKNOWN (no transcript_path in the payload) is NOT MAIN: a surface
// that does not send the field must not have every write denied, so callers treat unknown as
// cannot-tell and warn instead of blocking. Guessing MAIN there would freeze work; guessing
// SUBAGENT would silently disable the enforcement.

import { basename, dirname } from 'node:path';

export const AGENT_CONTEXT = Object.freeze({
  MAIN: 'main',
  SUBAGENT: 'subagent',
  UNKNOWN: 'unknown',
});

const SUBAGENT_DIRECTORY = 'subagents';

export function transcriptPathOf(rawPayload) {
  try {
    const payload = JSON.parse(rawPayload);
    const path = payload?.transcript_path ?? payload?.transcriptPath;
    return typeof path === 'string' ? path : '';
  } catch {
    return '';
  }
}

export function agentContextOfPath(transcriptPath) {
  const path = String(transcriptPath ?? '').trim();
  if (path === '') return AGENT_CONTEXT.UNKNOWN;
  // Separators are normalized because the payload carries native Windows paths.
  const normalized = path.replaceAll('\\', '/');
  return basename(dirname(normalized)) === SUBAGENT_DIRECTORY
    ? AGENT_CONTEXT.SUBAGENT
    : AGENT_CONTEXT.MAIN;
}

export function agentContextOf(rawPayload) {
  return agentContextOfPath(transcriptPathOf(rawPayload));
}

export function isSubagentCall(rawPayload) {
  return agentContextOf(rawPayload) === AGENT_CONTEXT.SUBAGENT;
}
