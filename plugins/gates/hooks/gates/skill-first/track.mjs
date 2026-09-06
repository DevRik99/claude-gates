// skill-first/track.mjs — PostToolUse. Records which skills this session actually loaded,
// so the gate can tell "the model reached for a skill" from "the model never asked". This
// is the strongest of the three ways to clear skill-first, and the only one that is not
// the model's own assertion: it is the runtime observing a real Skill call.
//
// Never blocks and never speaks; a failure here only costs the session that one signal.

import {
  allow,
  mcpActionSegment,
  readHookPayload,
  sessionIdOf,
  toolInGroups,
  toolInputOf,
  toolNameOf,
} from '../../lib/hook-io.mjs';
import { updateSessionState } from '../../lib/session-state.mjs';

const GATE_ID = 'skill-first';
const MAX_ENTRIES = 60;
const MAX_ENTRY_LENGTH = 120;

const NAME_FIELDS = ['skill', 'skill_name', 'skillName', 'name', 'id'];

/** The skill a Skill-style call names, across native and MCP field shapes. */
function skillNameOf(toolInput, toolName) {
  for (const field of NAME_FIELDS) {
    const value = toolInput?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // An MCP server may encode the skill in the action segment instead of an argument.
  return mcpActionSegment(String(toolName)) || null;
}

// A plugin skill arrives as `plugin:skill`, a directory-scoped one as `path/to:skill`;
// the catalog knows it by the bare name, so both spellings are recorded.
function spellingsOf(name) {
  const bare = name.includes(':') ? name.split(':').at(-1) : name;
  return [...new Set([name, bare])]
    .filter(Boolean)
    .map((entry) => entry.slice(0, MAX_ENTRY_LENGTH));
}

function main() {
  const rawPayload = readHookPayload();
  if (rawPayload === null) allow();
  const toolName = toolNameOf(rawPayload) ?? '';
  if (!toolInGroups(toolName, ['skill'])) allow();

  const name = skillNameOf(toolInputOf(rawPayload), toolName);
  if (!name) allow();

  updateSessionState(GATE_ID, sessionIdOf(rawPayload), {}, (state) => ({
    ...state,
    skillsInvoked: [...(state.skillsInvoked ?? []), ...spellingsOf(name)].slice(
      -MAX_ENTRIES,
    ),
  }));
  allow();
}

try {
  main();
} catch {
  allow();
}
