// stop-pending — the hook that obliges the assistant not to leave pending tasks behind.
// On the Stop event, if the project's task store (`.ai/tasks/active.json`) has ACTIVE
// tasks (status open/in_forge — see allowStopWithBlockedTasks for `blocked`), this BLOCKS
// the stop and lists them with how to close each: `task close --evidence` or `task
// abandon`.
//
// justification: no existing tool covers this. The tasks plugin (register-requests.mjs,
// session-tasks.mjs) reminds and recites; nothing in this repo stops the agent from ending
// a turn while a task is still open — that requires a Stop hook that can BLOCK, which only
// this event shape supports.
//
// ── Stop hook event shape (Claude Code) ──────────────────────────────────────────────
// stdin carries JSON: { session_id, stop_hook_active, ... }. To block the stop (make the
// agent continue instead of ending the turn), print {"decision":"block","reason":"..."}
// and exit 0 — `reason` is shown to the model so it knows what to do next. To allow the
// stop, print nothing (or {}) and exit 0.
//
// ── stop_hook_active loop-guard (mandatory) ──────────────────────────────────────────
// If a Stop hook already blocked once in this cycle, Claude Code re-invokes Stop hooks
// with stop_hook_active=true. Blocking AGAIN here would never let the turn end — an
// infinite loop. So: whenever stop_hook_active === true, this gate unconditionally allows
// the stop, even if pending tasks remain. That trades "always caught" for "never hangs the
// session" — a single missed reminder is recoverable, a frozen session is not.
//
// ── Why this re-reads active.json directly instead of importing task-store.mjs ──────
// The task store lives in a DIFFERENT plugin (plugins/tasks/hooks/lib/task-store.mjs).
// Importing across plugin boundaries makes each plugin's installability depend on the
// other being present at a specific relative path — exactly the coupling every other gate
// in this repo avoids by being self-contained (Node built-ins only). This gate instead
// re-reads the on-disk JSON shape directly: `{ tasks: [ { id, title, status, ... } ] }`
// with status one of open/blocked/in_forge/done/abandoned (done/abandoned already live
// only in history.json, never in active.json, by task-store's own close() contract — so
// active.json is never filtered by status here beyond blocked/allowStopWithBlockedTasks).
// A change to that shape would need updating in two places, but a cross-plugin import
// would need the OTHER plugin installed at all, which is worse for a gate meant to work
// standalone.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   allowStopWithBlockedTasks   when true (default), a task with status 'blocked' (a
//                               declared cause + a next condition) does NOT prevent stop —
//                               only open/in_forge do. Set false to also block on 'blocked'.
//
// ── Fail-safe shape (mandatory for a Stop hook) ──────────────────────────────────────
// Everything below is wrapped in try/catch. No plugin/tasks installed, no .ai/tasks/, a
// corrupt active.json, or ANY unexpected error: allow the stop. A broken Stop hook must
// never hang a session — that is worse than one missed reminder.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isGateEnabled, gateParameters } from '../../lib/config.mjs';
import { readHookPayload } from '../../lib/hook-io.mjs';

const GATE_ID = 'stop-pending';
const CONFIG_KEY = 'blockStopWithPendingTasks';

const PROJECT_ROOT_MARKERS = ['.git', '.ai'];
const ACTIVE_TASKS_FILE = join('.ai', 'tasks', 'active.json');
const BLOCKING_STATUSES = new Set(['open', 'in_forge']);
const BLOCKED_STATUS = 'blocked';

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function projectRootOf(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Reads .ai/tasks/active.json's task list directly. [] on any absence/corruption. */
function readActiveTasks(root) {
  const path = join(root, ACTIVE_TASKS_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(stripBom(readFileSync(path, 'utf8')));
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

function blockingTasksFrom(tasks, allowBlocked) {
  return tasks.filter((task) => {
    if (BLOCKING_STATUSES.has(task.status)) return true;
    return !allowBlocked && task.status === BLOCKED_STATUS;
  });
}

function describeTasks(tasks) {
  return tasks
    .map(
      (task) =>
        `  - [${task.status}] ${task.id}: ${task.title ?? '(untitled)'}` +
        (task.status === BLOCKED_STATUS && task.blockedReason
          ? ` (blocked: ${task.blockedReason})`
          : ''),
    )
    .join('\n');
}

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

    // Loop-guard: a Stop hook already blocked once this cycle. Never block again.
    if (payload?.stop_hook_active === true) return allow();

    const cwd = process.cwd();
    // registryDefault MUST match this gate's `default` in registry.json (true). The gate
    // does not read the registry — this literal IS its default when a project config is
    // silent about the key. It was false while the registry said false; both moved to true
    // so the pending-task reminder actually fires on a fresh install, not only when the
    // user's config names the key explicitly.
    if (!isGateEnabled(CONFIG_KEY, true, cwd)) return allow();

    const root = projectRootOf(cwd);
    if (!root) return allow(); // no project: nothing to check

    const parameters = gateParameters(CONFIG_KEY, cwd);
    const allowBlocked = parameters.allowStopWithBlockedTasks !== false; // default true

    const tasks = readActiveTasks(root);
    const blockingTasks = blockingTasksFrom(tasks, allowBlocked);
    if (blockingTasks.length === 0) return allow();

    return block(
      `[${GATE_ID}] There are ${blockingTasks.length} pending task(s) still active for this ` +
        `project:\n${describeTasks(blockingTasks)}\n` +
        'Close each before ending the turn: `task close <id> --evidence "..."` when done, ' +
        'or `task abandon <id> --reason "..."` when it will not be finished. A task left ' +
        '`blocked` with a stated cause does not require closing unless ' +
        'allowStopWithBlockedTasks is set to false.',
    );
  } catch {
    // A broken Stop hook must never hang the session.
    return allow();
  }
}

main();
