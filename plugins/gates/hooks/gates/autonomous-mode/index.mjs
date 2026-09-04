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

import { runGate, deny, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'autonomous-mode';
const CONFIG_KEY = 'autonomousMode';

// The tool groups whose members are "asking the user something". `toolInGroups` matches the
// native AskUserQuestion AND any MCP ask/confirm/elicit surface (mcp__*__ask_user_*), so an
// autonomous run can't be interrupted by a question routed through an MCP server either.
const QUESTION_GROUPS = ['question'];

const DENY_MESSAGE =
  'Autonomous mode is ON. Do not ask the user. Decide and proceed. ' +
  'Use this order: existing project decisions > existing patterns > requirements > project goals > your judgment. ' +
  'Keep decisions consistent with the project. Do not invent new patterns or technologies unless needed. ' +
  'When several choices work, pick the one best for the project. Make reasonable reversible assumptions instead of asking. ' +
  'In your visible reply, leave one line: "[autonomous] I was going to ask <question>; I chose <decision>, assuming <assumption>." ' +
  'Only stop for genuinely irreversible or dangerous actions (data deletion, money, destructive production changes). ' +
  'If stopping, explain what and why. Never ask the popup again. ' +
  'To enable questions, set "autonomousMode": false in .ai/config.json.';

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
  },
  ({ toolName }) => {
    if (!toolInGroups(toolName, QUESTION_GROUPS)) return;
    deny(CONFIG_KEY, DENY_MESSAGE);
  },
);
