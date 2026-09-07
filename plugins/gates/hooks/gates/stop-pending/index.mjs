// stop-pending — the Stop hook that keeps the assistant from ending a turn while the
// project's task store still has ACTIVE tasks (open/in_forge; `blocked` only when
// allowStopWithBlockedTasks is false). It re-reads .ai/tasks/active.json directly rather
// than importing the tasks plugin: a cross-plugin import would make this gate depend on the
// other plugin being installed at a fixed relative path. Loop guard and fail-open come from
// runStopHook — a broken Stop hook must never hang a session.

import { join } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import { block, runStopHook } from '../../lib/hook-io.mjs';
import { blocksCaller, ownerOf } from '../../lib/task-claims.mjs';

const GATE_ID = 'stop-pending';
const CONFIG_KEY = 'blockStopWithPendingTasks';

const ACTIVE_TASKS_FILE = join('.ai', 'tasks', 'active.json');
const BLOCKING_STATUSES = new Set(['open', 'in_forge']);
const BLOCKED_STATUS = 'blocked';

function readActiveTasks(root) {
  const parsed = readJsonOrNull(join(root, ACTIVE_TASKS_FILE));
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  return tasks.filter((task) => task && typeof task === 'object');
}

// Porque esperar por la tarea viva de OTRO agente dejaba a este sin poder terminar por algo
// que no empezó y que además no podía cerrar honestamente, solo retiene el turno el trabajo
// del que responde quien actúa.
function blockingTasksFrom(tasks, allowBlocked, caller, root) {
  return tasks.filter((task) => {
    if (!blocksCaller(task, caller, Date.now(), root)) return false;
    if (BLOCKING_STATUSES.has(task.status)) return true;
    return !allowBlocked && task.status === BLOCKED_STATUS;
  });
}

function describeTask(task) {
  const blockedNote =
    task.status === BLOCKED_STATUS && task.blockedReason
      ? ` (blocked: ${task.blockedReason})`
      : '';
  const claim = ownerOf(task) ? ' · yours' : ' · unclaimed';
  return `  - [${task.status}] ${task.id ?? '(no id)'}: ${task.title ?? '(untitled)'}${blockedNote}${claim}`;
}

runStopHook(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: { allowStopWithBlockedTasks: true },
  },
  ({ parameters, sessionId, cwd }) => {
    const root = projectRootOf(cwd) ?? cwd;
    const blockingTasks = blockingTasksFrom(
      readActiveTasks(root),
      parameters.allowStopWithBlockedTasks !== false,
      sessionId,
      root,
    );
    if (blockingTasks.length === 0) return;

    block(
      CONFIG_KEY,
      `There are ${blockingTasks.length} pending task(s) that are yours to close ` +
        `(another agent's live-claimed tasks are not listed):\n${blockingTasks.map(describeTask).join('\n')}\n` +
        'Close each before ending the turn, with VERIFIED evidence (free text is not ' +
        'accepted): `task close <id> --check "<command that must exit 0>" [--expect <text>]` ' +
        'or `task close <id> --exists <path> [--contains <text>]` (add `--note "..."` for ' +
        'context), or `task abandon <id> --reason "..."` when it will not be finished. A task ' +
        'left `blocked` with a stated cause does not require closing unless ' +
        'allowStopWithBlockedTasks is set to false.',
    );
  },
);
