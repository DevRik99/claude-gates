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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

// ── Propiedad de una tarea ──────────────────────────────────────────────────────────
// Varios agentes comparten este fichero, y hasta ahora una tarea no tenía dueño: los gates
// no podían distinguir "hay una tarea sin dividir" de "hay una tarea sin dividir MÍA", así
// que la tarea de un agente congelaba a todos los demás. `owner` es lo que rompe eso.
//
// El dueño es el id de sesión de Claude Code (CLAUDE_CODE_SESSION_ID): una sesión es un
// agente. Sin dueño vivo la tarea está LIBRE y cualquiera puede reclamarla — libre no
// significa "de nadie y por tanto bloquea a todos", significa "todavía no la tomó nadie".
//
// La reserva CADUCA porque un agente que muere sin liberar retendría su trabajo para
// siempre; pasado el TTL la tarea vuelve a estar libre sin que nadie tenga que intervenir.
const CLAIM_TTL_HOURS = 8;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const CLAIM_TTL_MS =
  CLAIM_TTL_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

export { CLAIM_TTL_MS };

export function ownerOf(task) {
  const owner = task?.owner;
  return typeof owner === 'string' && owner.length > 0 ? owner : null;
}

export function claimIsLive(
  task,
  { now = Date.now(), ttlMs = CLAIM_TTL_MS } = {},
) {
  if (!ownerOf(task)) return false;
  const claimedAt = Date.parse(String(task.claimedAt ?? ''));
  // Porque una reserva sin fecha viene de una tarea escrita antes de este campo, se respeta
  // en vez de caducar al instante: tratarla como libre se la quitaría a quien la trabaja.
  if (Number.isNaN(claimedAt)) return true;
  return now - claimedAt < ttlMs;
}

export function isFree(task, options) {
  return !claimIsLive(task, options);
}

export function isOwnedBy(task, owner, options) {
  return (
    Boolean(owner) && claimIsLive(task, options) && ownerOf(task) === owner
  );
}

export function ownedPathsOf(task) {
  return Array.isArray(task?.owns) ? task.owns.filter(Boolean).map(String) : [];
}

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
const BOM_CODE_POINT = 0xfeff;

function stripBom(text) {
  return text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text;
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

// Temp file + rename, because this is the one file several agents working in parallel all
// write at once, and a plain writeFileSync leaves a window where a concurrent reader sees a
// half-written file — or worse, two `task add` calls read the same list and the second
// write silently drops the first agent's task. lib/session-state.mjs already writes this
// way; the store, which is the piece that actually has multiple writers, did not.
//
// This narrows the window, it does not close it: a genuine read-modify-write race between
// two processes still needs a lock. Rename being atomic means a reader never sees a torn
// file, which is the failure that corrupts state rather than just losing a row.
function writeCollection(path, collection) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(
    temporary,
    `${JSON.stringify(collection, null, JSON_INDENT)}\n`,
    'utf8',
  );
  renameSync(temporary, path);
}

/**
 * Closes an active task: sets a terminal status + closedAt + closeReason, then MOVES it
 * from active to history (append-only). Nothing is deleted. Returns { task } on success,
 * or { error } describing why it was refused — so a caller can tell "not found" from
 * "done without evidence" and surface the right message.
 *
 * Closing as `done` REQUIRES non-empty `evidence` (a command output, a test result, a
 * diff, a verification note): a request is never marked resolved on a claim alone.
 * `abandoned` needs only a reason.
 *
 * Extracted from the `openTaskStore` handle purely to keep that function's line count
 * within the project's budget — same behavior, same order, just a named module function
 * taking the two paths it needs instead of closing over them.
 */
function closeTask(
  activePath,
  historyPath,
  id,
  status,
  { reason, evidence } = {},
) {
  if (!TERMINAL_STATUSES.has(status)) {
    return { error: `invalid terminal status: ${status}` };
  }
  if (STATUS_REQUIRING_EVIDENCE.has(status) && evidence?.verified !== true) {
    return {
      error:
        'closing a task as done requires VERIFIED evidence: a command that passed ' +
        '(--check "<command>" [--expect <text>]) or a path that exists (--exists <path> ' +
        '[--contains <text>]). Free text is not evidence. Close it as abandoned with a ' +
        'reason if it will not be finished.',
    };
  }
  const activeCollection = readCollection(activePath);
  const index = activeCollection.tasks.findIndex((entry) => entry.id === id);
  if (index === -1) return { error: `no active task with id ${id}` };

  const [task] = activeCollection.tasks.splice(index, 1);
  task.status = status;
  task.closedAt = new Date().toISOString();
  task.closeReason = reason ?? '';
  if (STATUS_REQUIRING_EVIDENCE.has(status)) task.evidence = evidence;

  const historyCollection = readCollection(historyPath);
  historyCollection.tasks.push(task);

  writeCollection(historyPath, historyCollection);
  writeCollection(activePath, activeCollection);
  return { task };
}

/**
 * Toma una tarea para `owner`. Se rechaza SOLO si otro agente la tiene con reserva viva: una
 * tarea libre, una caducada, y la que ya es tuya se conceden — reclamar lo tuyo otra vez es
 * renovar, no un conflicto. El error nombra al dueño actual porque "está ocupada" sin decir
 * por quién no deja hacer nada al respecto.
 *
 * Módulo aparte y no método del handle por lo mismo que `closeTask`: mantener `openTaskStore`
 * dentro del presupuesto de líneas del proyecto.
 */
function updateTask(activePath, id, fields) {
  const collection = readCollection(activePath);
  const task = collection.tasks.find((entry) => entry.id === id);
  if (!task) return null;
  Object.assign(task, fields);
  writeCollection(activePath, collection);
  return task;
}

// undefined y no null, para que JSON.stringify borre las claves en vez de dejar lápidas.
const RELEASED = Object.freeze({ owner: undefined, claimedAt: undefined });

function activeMatching(activePath, predicate) {
  return readCollection(activePath).tasks.filter(predicate);
}

function claimTask(activePath, id, owner, options) {
  if (!owner) return { error: 'claim needs an owner id' };
  const task = readCollection(activePath).tasks.find(
    (entry) => entry.id === id,
  );
  if (!task) return { error: `no active task with id ${id}` };
  if (claimIsLive(task, options) && ownerOf(task) !== owner) {
    return {
      error:
        `task ${id} is already claimed by ${ownerOf(task)} (since ${task.claimedAt}). ` +
        'Pick a free task (`task list --free`), or wait for that agent to release it.',
    };
  }
  return {
    task: updateTask(activePath, id, {
      owner,
      claimedAt: new Date().toISOString(),
    }),
  };
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
    /** Active sub-tasks whose parentId equals the given id. */
    childrenOf(id) {
      return readCollection(activePath).tasks.filter(
        (task) => task.parentId === id,
      );
    },
    /** Merges fields into the active task with matching id. Null if not found. */
    update(id, fields) {
      return updateTask(activePath, id, fields);
    },
    close(id, status, options) {
      return closeTask(activePath, historyPath, id, status, options);
    },
    /**
     * Promotes an active task to a forge run: records the run id and flips status to in_forge
     * (still active — it is being executed, not closed). Whether a task is promoted is the
     * assistant's judgment, not a rule; this only records the link. Null if id not found.
     */
    promoteToForge(id, forgeRunId) {
      return this.update(id, {
        status: STATUS.IN_FORGE,
        forgeRunId: String(forgeRunId),
      });
    },
    /**
     * Parks a task on a stated cause. `blocked` is the escape valve the rest of the system
     * already honours — require-task-split counts only open/in_forge, and stop-pending lets
     * a blocked task through — but nothing could REACH it: the status existed, both gates
     * respected it, and no operation produced it, so a task that could not move forward and
     * could not be honestly closed had no legal state and deadlocked both gates instead.
     * The reason is mandatory because a task parked without a cause is indistinguishable
     * from one that was quietly dropped.
     */
    block(id, reason) {
      return this.update(id, {
        status: STATUS.BLOCKED,
        blockedReason: String(reason),
      });
    },
    unblock(id) {
      // undefined (not null) so JSON.stringify drops the key instead of persisting a tombstone.
      return this.update(id, {
        status: STATUS.OPEN,
        blockedReason: undefined,
      });
    },
    claim(id, owner, options) {
      return claimTask(activePath, id, owner, options);
    },
    release(id) {
      return updateTask(activePath, id, RELEASED);
    },
    ownedBy(owner, options) {
      return activeMatching(activePath, (task) =>
        isOwnedBy(task, owner, options),
      );
    },
    free(options) {
      return activeMatching(activePath, (task) => isFree(task, options));
    },
    /** The message counter since the last reminder (0 when unset or unreadable). */
    counter() {
      if (!existsSync(counterPath)) return 0;
      try {
        return (
          JSON.parse(stripBom(readFileSync(counterPath, 'utf8'))).count ?? 0
        );
      } catch {
        return 0;
      }
    },
    /** Sets the message counter. */
    setCounter(count) {
      writeCollection(counterPath, { count });
    },
  };
}
