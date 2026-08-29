// autonomous-mode — when the project turns on autonomous mode, the assistant must stop
// asking and decide. This gate denies the AskUserQuestion tool while the mode is on, so a
// question popup cannot interrupt an unattended run. The assistant is expected to take the
// best, aligned decision and state the reversible assumption instead of asking.
//
// justification: no existing tool covers this. It is the deterministic half of "run without
// asking": a gate can block the question tool; the prose reminder (via the session-start
// hook and this gate's message) covers the rest, which a hook cannot force.
//
// ── When it acts ────────────────────────────────────────────────────────────────────
// Only when autonomousMode is enabled in .ai/config.json (project) or the global config.
// Off by default. The user is also reminded at session start that the mode is on (see the
// session hook), in case they forgot to turn it off.
//
// ── What it does NOT do ─────────────────────────────────────────────────────────────
// It blocks the AskUserQuestion TOOL. It cannot stop the assistant from asking in plain
// prose (no hook sees chat text) — the injected reminder pushes against that, but the only
// deterministic lever is the question tool, and this gate pulls it.

import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'autonomous-mode';
const CONFIG_KEY = 'autonomousMode';

const QUESTION_TOOLS = new Set(TOOL_GROUPS.question);

const DENY_MESSAGE =
  'Autonomous mode is ON for this project: do not ask the user. Take the best decision ' +
  'that is aligned with the goal and the project rules, state the reversible assumption you ' +
  'made, and proceed. Only a genuinely irreversible or dangerous choice (deleting data, ' +
  'money, production) would justify stopping — and then say so in prose, do not use the ' +
  'question popup. To let questions through again, set "autonomousMode": false in ' +
  '.ai/config.json.';

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
  },
  ({ toolName }) => {
    if (!QUESTION_TOOLS.has(toolName)) return;
    deny(GATE_ID, DENY_MESSAGE);
  },
);
