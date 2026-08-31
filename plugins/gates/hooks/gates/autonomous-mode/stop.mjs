// autonomous-mode (Stop half) — closes the hole its PreToolUse half cannot reach. The
// PreToolUse gate (index.mjs) blocks the AskUserQuestion TOOL, but nothing stops the
// assistant from ending its turn with a question in plain PROSE — and when it does, the
// session just sits there waiting for a human who is supposed to be away. No hook can read
// chat text to detect that a turn ended on a question. So this Stop hook takes the only
// deterministic lever available: when autonomous mode is ON and the turn is ending, it
// re-injects an instruction to NOT wait — decide, delegate, and keep going on everything
// that does not strictly require the user's own explicit decision.
//
// ── What the re-injected message says (per the user's own framing) ───────────────────
// In autonomous mode work is delegated to the assistant. It must only leave pending the ONE
// thing that genuinely needs the user's exclusive, explicit decision (irreversible/dangerous
// — deleting data, money, production). Everything else: proceed. If there are OTHER tasks it
// can advance, advance them; isolate only the truly blocking one and state it in prose, then
// stop. It must not end the turn on a prose question just to wait.
//
// ── stop_hook_active loop-guard (mandatory) ──────────────────────────────────────────
// Claude Code re-invokes Stop hooks with stop_hook_active=true after a block. Blocking again
// would loop forever. So when stop_hook_active === true this hook unconditionally allows the
// stop: the reminder is injected exactly once per cycle. After that one nudge, if the
// assistant still ends the turn, it genuinely had nothing to proceed on (or a real blocker),
// and the session must be allowed to end — a frozen session is worse than one missed nudge.
//
// ── Fail-safe (mandatory for a Stop hook) ────────────────────────────────────────────
// Everything is wrapped so that no config, no project, a corrupt payload, or any unexpected
// error allows the stop. A broken Stop hook must never hang a session.

import { isGateEnabled } from '../../lib/config.mjs';
import { readHookPayload } from '../../lib/hook-io.mjs';

const GATE_ID = 'autonomous-mode';
const CONFIG_KEY = 'autonomousMode';

const CONTINUE_MESSAGE =
  '[autonomous] Autonomous mode is ON — do not end the turn to wait for the user. Work here ' +
  'is delegated to you. Leave PENDING only the one thing that genuinely needs the user’s own ' +
  'explicit, exclusive decision (a truly irreversible or dangerous choice: deleting data, ' +
  'money, production). For everything else: decide the best goal-aligned option, state the ' +
  'reversible assumption in one line, and proceed. If there are OTHER tasks you can advance, ' +
  'advance them now instead of stopping; isolate only the genuinely blocking item, state it ' +
  'in prose, and stop only for that. Do NOT end the turn on a prose question just to wait. ' +
  'If you have truly nothing left to do and nothing needs the user, ending is fine — this ' +
  'reminder fires once, so a real end will go through on the next stop.';

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function allow() {
  process.exit(0);
}

function main() {
  try {
    const rawPayload = readHookPayload();
    if (rawPayload === null) return allow();

    let payload;
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return allow(); // unparseable Stop payload: fail-safe, never hang the session
    }

    // Loop-guard: this hook already nudged once this cycle. Never block again.
    if (payload?.stop_hook_active === true) return allow();

    // Only act when the project turned autonomous mode ON. Off by default (registry).
    if (!isGateEnabled(CONFIG_KEY, false, process.cwd())) return allow();

    return block(CONTINUE_MESSAGE);
  } catch {
    // A broken Stop hook must never hang a session.
    return allow();
  }
}

main();
