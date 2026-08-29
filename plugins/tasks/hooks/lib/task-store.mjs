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

/** Statuses a task can hold. Active: open/blocked. Terminal (moved to history): done/abandoned. */
export const STATUS = Object.freeze({
  OPEN: 'open',
  BLOCKED: 'blocked',
  DONE: 'done',
  ABANDONED: 'abandoned',
});

const TERMINAL_STATUSES = new Set([STATUS.DONE, STATUS.ABANDONED]);

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

function readCollection(path) {
  if (!existsSync(path)) return { tasks: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
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
     * from active to history (append-only). Nothing is deleted. Returns the closed task, or
     * null when the id or status is invalid.
     */
    close(id, status, reason) {
      if (!TERMINAL_STATUSES.has(status)) return null;
      const activeCollection = readCollection(activePath);
      const index = activeCollection.tasks.findIndex(
        (entry) => entry.id === id,
      );
      if (index === -1) return null;

      const [task] = activeCollection.tasks.splice(index, 1);
      task.status = status;
      task.closedAt = new Date().toISOString();
      task.closeReason = reason ?? '';

      const historyCollection = readCollection(historyPath);
      historyCollection.tasks.push(task);

      writeCollection(historyPath, historyCollection);
      writeCollection(activePath, activeCollection);
      return task;
    },
    /** The message counter since the last reminder (0 when unset or unreadable). */
    counter() {
      if (!existsSync(counterPath)) return 0;
      try {
        return JSON.parse(readFileSync(counterPath, 'utf8')).count ?? 0;
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
