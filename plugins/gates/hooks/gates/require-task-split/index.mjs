// require-task-split — denies writes and execution when the active task is too large
// to implement without sub-tasks. Deterministic: reads active.json, checks size and
// children count, denies unconditionally when the criteria are not met.
//
// Inspired by the Depth Tree method (unlazy): each sub-task must own specific files
// (OWNS), carry its own verification gate, and be independently completable. If the
// task's scope is ambiguous or the description is too vague to split confidently, the
// model must ask the user to clarify before registering sub-tasks.
//
// Sizes that require splitting: medium, large, unspecified (anything that is not
// explicitly small or trivial). A task that already has sub-tasks (children with
// matching parentId) passes. A project with no tasks also passes (nothing to enforce).

import { join } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import {
  deny,
  runGate,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
} from '../../lib/hook-io.mjs';
import {
  isReadOnlyCommand,
  isSelfRemedyCommand,
} from '../../lib/shell-safety.mjs';
import { blocksCaller } from '../../lib/task-claims.mjs';

const GATE_ID = 'require-task-split';
const CONFIG_KEY = 'requireTaskSplitBeforeImplementing';

const ACTIVE_TASKS_FILE = join('.ai', 'tasks', 'active.json');
const SIZES_EXEMPT_FROM_SPLIT = new Set(['small', 'trivial']);
const IMPLEMENTATION_STATUSES = new Set(['open', 'in_forge']);

function readActiveTasks(root) {
  const parsed = readJsonOrNull(join(root, ACTIVE_TASKS_FILE));
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  return tasks.filter((task) => task && typeof task === 'object');
}

function hasChildren(tasks, parentId) {
  return tasks.some((task) => task.parentId === parentId);
}

// Only the caller's own work counts, because with several agents in one project this gate
// froze whoever was NOT responsible: one agent's unsplit task denied every execution for
// everyone, while nobody was touching the same file. It blocked the harmless case (untidy
// bookkeeping elsewhere) and never guarded the dangerous one (two agents editing one file).
//
// The full rule (why a free task still blocks, why a claim dies with its session) lives in
// lib/task-claims.mjs, shared with stop-pending: a second copy is where the two silently
// drift apart, which is exactly what lib/shell-safety.mjs documents having already happened.
function unsplitLargeTasks(tasks, owner, root) {
  return tasks.filter((task) => {
    if (!IMPLEMENTATION_STATUSES.has(task.status)) return false;
    if (task.parentId) return false;
    if (SIZES_EXEMPT_FROM_SPLIT.has(task.size)) return false;
    if (!blocksCaller(task, owner, Date.now(), root)) return false;
    return !hasChildren(tasks, task.id);
  });
}

const DENY_MESSAGE_TEMPLATE = (count, lines) =>
  `${count} task(s) need splitting before implementation:\n${lines}\n\n` +
  'BEFORE SPLITTING — check scope clarity:\n' +
  '  If the task description is vague or you are unsure what files/modules are affected,\n' +
  '  ASK THE USER to clarify the scope before registering sub-tasks. Do not guess.\n\n' +
  'SPLITTING RULES (Depth Tree method):\n' +
  '  1. Each sub-task must be small and independently verifiable\n' +
  '  2. Each sub-task should OWN specific files — no two sub-tasks modify the same file\n' +
  '  3. Each sub-task carries its own verification gate (--verify-command or --verify-path)\n' +
  '  4. Split at natural boundaries: one module, one function, one test file\n' +
  '  5. If the task has unclear scope, ask the user — do not split blindly\n\n' +
  'Register sub-tasks:\n' +
  '  claude-gates task add "<what this sub-task delivers>" --parent <parent-id> --size small \\\n' +
  '    --verify-command "<check>" [--verify-expect <text>] \\\n' +
  '    --description "OWNS: <file1>, <file2>"\n\n' +
  'Only after sub-tasks are registered can you proceed with writes and execution.';

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {},
  },
  ({ toolName, toolInput, sessionId, cwd }) => {
    const isWrite = toolInGroups(toolName, ['write']);
    const isExecution = toolInGroups(toolName, ['execution']);
    if (!isWrite && !isExecution) return;

    // This gate's whole remedy is a shell command (`task add --parent`), and diagnosing
    // why it fired needs another (`task list`). Denying those made the message order
    // something the gate itself refused, closing every sanctioned way out — see
    // cli/__tests__/gate-invariants.test.mjs, which now fails if this exemption is lost.
    if (toolInGroups(toolName, ['shell'])) {
      const command = shellCommandOf(toolInput);
      if (isSelfRemedyCommand(command)) return;
      if (
        isReadOnlyCommand(command, {
          writesPaths: shellWrittenPaths(command).length > 0,
        })
      )
        return;
    }

    const root = projectRootOf(cwd) ?? cwd;
    const tasks = readActiveTasks(root);
    if (tasks.length === 0) return;

    const unsplit = unsplitLargeTasks(tasks, sessionId, root);
    if (unsplit.length === 0) return;

    const lines = unsplit
      .map(
        (task) =>
          `  - [${task.status}] ${task.id}: ${task.title} (size: ${task.size ?? 'unspecified'})`,
      )
      .join('\n');
    deny(CONFIG_KEY, DENY_MESSAGE_TEMPLATE(unsplit.length, lines));
  },
);
