// The task store: the single source of truth for a project's tasks, on disk under
// .ai/tasks/. Self-contained (Node built-ins only) so a hook can use it when the plugin is
// installed on its own.
//
// justification: no existing tool covers this. Audited LOCAL deps (find-up, commander,
// @clack/prompts, zod — none is a task store), CONTEXT7 (generic JSON-store libs), and WEB
// (victor-software-house/task-tracker-plugin and Claude Code's native task manager both
// persist tasks and survive compaction, but neither distills tasks from chat, none is a
// zero-runtime-dependency library, and none fits the active/history + git-root shape here).
// The generic persistence is a solved pattern; this store is the thin, dependency-free,
// domain-specific piece the value layer (distil + remind + unlazy) sits on.
//
// Two files, mirroring the harness-sdd model:
//   active.json   { tasks: [ {id, title, description, status, size, createdAt, messages[]} ] }
//   history.json  { tasks: [ ...same shape + closedAt + closeReason ] }  — append-only
// A task is never deleted: done and abandoned tasks MOVE from active to history, so the
// record of what was decided (and dropped) is never lost.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TASKS_DIR = join('.ai', 'tasks');
const ACTIVE_FILE = 'active.json';
const HISTORY_FILE = 'history.json';
const COUNTER_FILE = 'counter.json';
const JSON_INDENT = 2;
// A project root holds `.git` or `.ai/` — the same set the CLI and the gates config use, so
// a repo-less project (no git yet) still resolves. Anchoring on `.git` alone drops it.
const PROJECT_ROOT_MARKERS = ['.git', '.ai'];

/** Statuses a task can hold. Active: open/blocked/in_forge. Terminal (history): done/abandoned. */
export const STATUS = Object.freeze({
  OPEN: 'open',
  BLOCKED: 'blocked',
  IN_FORGE: 'in_forge', // promoted to a forge run for pipeline execution; still active
  DONE: 'done',
  ABANDONED: 'abandoned',
});

const TERMINAL_STATUSES = new Set([STATUS.DONE, STATUS.ABANDONED]);
// A task closed as done must carry evidence it was actually attended and resolved — the
// project rule "ningún pedido se marca hecho sin evidencia válida" made mechanical. Abandoned
// needs only a reason (it is a deliberate drop, not a claim of completion), so it is exempt.
const STATUS_REQUIRING_EVIDENCE = new Set([STATUS.DONE]);

/** Climbs to the nearest project root (a dir holding `.git` or `.ai/`); null when none. */
export function projectRootOf(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (
      PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Node's readFileSync('utf8') does not strip a leading UTF-8 BOM (EF BB BF, decoded as
// U+FEFF), and JSON.parse rejects a string starting with it. A file written by a BOM-adding
// editor or `PowerShell Set-Content -Encoding utf8` would otherwise silently read back as
// "corrupt" (caught below, treated as empty) — the same failure mode that made the gates'
// own config.mjs treat a valid project config as absent. Stripping it here is the fix.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readCollection(path) {
  if (!existsSync(path)) return { tasks: [] };
  try {
    const parsed = JSON.parse(stripBom(readFileSync(path, 'utf8')));
    return Array.isArray(parsed.tasks) ? parsed : { tasks: [] };
  } catch {
    return { tasks: [] };
  }
}

function writeCollection(path, collection) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(collection, null, JSON_INDENT)}\n`,
    'utf8',
  );
}

/**
 * Opens the store rooted at a project. All paths derive from the project root's .ai/tasks/.
 * Returns a handle with read/mutate operations; each mutation persists immediately so a
 * crash between calls never loses a recorded task. Null when there is no project (no .git).
 */
export function openTaskStore(startDirectory) {
  const root = projectRootOf(startDirectory);
  if (!root) return null;

  const directory = join(root, TASKS_DIR);
  const activePath = join(directory, ACTIVE_FILE);
  const historyPath = join(directory, HISTORY_FILE);
  const counterPath = join(directory, COUNTER_FILE);

  return {
    root,
    /** Open (non-terminal) tasks. */
    active() {
      return readCollection(activePath).tasks;
    },
    /** Terminal (done/abandoned) tasks, newest last. */
    history() {
      return readCollection(historyPath).tasks;
    },
    /** Adds a task to active and returns it. `id` is caller-supplied (stable, human-readable). */
    add(task) {
      const collection = readCollection(activePath);
      collection.tasks.push(task);
      writeCollection(activePath, collection);
      return task;
    },
    /** Merges fields into the active task with matching id. Null if not found. */
    update(id, fields) {
      const collection = readCollection(activePath);
      const task = collection.tasks.find((entry) => entry.id === id);
      if (!task) return null;
      Object.assign(task, fields);
      writeCollection(activePath, collection);
      return task;
    },
    /**
     * Closes an active task: sets a terminal status + closedAt + closeReason, then MOVES it
     * from active to history (append-only). Nothing is deleted. Returns { task } on success,
     * or { error } describing why it was refused — so a caller can tell "not found" from
     * "done without evidence" and surface the right message.
     *
     * Closing as `done` REQUIRES non-empty `evidence` (a command output, a test result, a
     * diff, a verification note): a request is never marked resolved on a claim alone.
     * `abandoned` needs only a reason.
     */
    close(id, status, { reason, evidence } = {}) {
      if (!TERMINAL_STATUSES.has(status)) {
        return { error: `invalid terminal status: ${status}` };
      }
      if (STATUS_REQUIRING_EVIDENCE.has(status) && !String(evidence ?? '').trim()) {
        return {
          error:
            'closing a task as done requires evidence that it was attended and resolved ' +
            '(test output, a diff, a verification note). Provide --evidence, or close it as ' +
            'abandoned with a reason if it will not be finished.',
        };
      }
      const activeCollection = readCollection(activePath);
      const index = activeCollection.tasks.findIndex(
        (entry) => entry.id === id,
      );
      if (index === -1) return { error: `no active task with id ${id}` };

      const [task] = activeCollection.tasks.splice(index, 1);
      task.status = status;
      task.closedAt = new Date().toISOString();
      task.closeReason = reason ?? '';
      if (STATUS_REQUIRING_EVIDENCE.has(status)) task.evidence = String(evidence).trim();

      const historyCollection = readCollection(historyPath);
      historyCollection.tasks.push(task);

      writeCollection(historyPath, historyCollection);
      writeCollection(activePath, activeCollection);
      return { task };
    },
    /**
     * Promotes an active task to a forge run: records the run id and flips status to in_forge
     * (still active — it is being executed, not closed). Whether a task is promoted is the
     * assistant's judgment, not a rule; this only records the link. Null if id not found.
     */
    promoteToForge(id, forgeRunId) {
      return this.update(id, { status: STATUS.IN_FORGE, forgeRunId: String(forgeRunId) });
    },
    /** The message counter since the last reminder (0 when unset or unreadable). */
    counter() {
      if (!existsSync(counterPath)) return 0;
      try {
        return JSON.parse(stripBom(readFileSync(counterPath, 'utf8'))).count ?? 0;
      } catch {
        return 0;
      }
    },
    /** Sets the message counter. */
    setCounter(count) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        counterPath,
        `${JSON.stringify({ count }, null, JSON_INDENT)}\n`,
        'utf8',
      );
    },
  };
}
