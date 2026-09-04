// autonomous-mode (Stop half) — the PreToolUse gate blocks the question TOOL, but nothing
// stops the assistant from ending its turn on a question in plain prose, leaving the
// session waiting for a human who is away. No hook can read chat text, so this Stop hook
// re-injects, once per cycle, the instruction to decide and keep going. The loop guard
// (stop_hook_active) and fail-open shape come from runStopHook: after one nudge, a real
// end of turn goes through.

import { block, runStopHook } from '../../lib/hook-io.mjs';

const GATE_ID = 'autonomous-mode';
const CONFIG_KEY = 'autonomousMode';

const CONTINUE_MESSAGE =
  'Autonomous mode is ON — do not end the turn to wait for the user. Work here ' +
  'is delegated to you. Leave PENDING only the one thing that genuinely needs the user’s own ' +
  'explicit, exclusive decision (a truly irreversible or dangerous choice: deleting data, ' +
  'money, production). For everything else: decide the best goal-aligned option, state the ' +
  'reversible assumption in one line, and proceed. If there are OTHER tasks you can advance, ' +
  'advance them now instead of stopping; isolate only the genuinely blocking item, state it ' +
  'in prose, and stop only for that. Do NOT end the turn on a prose question just to wait. ' +
  'If you have truly nothing left to do and nothing needs the user, ending is fine — this ' +
  'reminder fires once, so a real end will go through on the next stop.';

runStopHook(
  { id: GATE_ID, configKey: CONFIG_KEY, enabledByDefault: false },
  () => block(CONFIG_KEY, CONTINUE_MESSAGE),
);
