// file-ownership — the ONLY cross-agent block that earns its keep: a write to a file another
// agent has actively claimed. Everything else about parallel agents got NARROWER (see
// lib/task-claims.mjs); this one is the case those gates were failing to guard.
//
// justification: no existing gate covers this. protected-paths blocks a STATIC list the
// project configures, not a claim that moves between agents; require-task-split and
// stop-pending judge the task backlog, never the file being touched. The system already had
// the concept — `--description "OWNS: <paths>"` and the rule "no two sub-tasks modify the
// same file" — but OWNS lived only as prose inside a description string: nothing parsed it,
// nothing compared it. Two agents could declare the same file and edit it at once with
// nothing firing. This gate is what makes `owns` mean something.
//
// Scope is deliberately tiny. It fires only when ALL of these hold:
//   1. another agent holds a LIVE claim on a task (an expired claim frees the files),
//   2. that task declares `owns`,
//   3. the path being written matches one of those entries.
// A file nobody claimed is free to edit — that is the point. This never blocks on "somebody
// somewhere has a task", only on "this exact file is being worked on by someone else".
//
// OFF by default, and that is a judgment call worth stating: restarting Claude Code gives you
// a NEW session id, so your own claims from an hour ago would look like another agent's and
// block you from your own files. Turn it on when you actually run agents in parallel, which
// is when the protection is worth that cost.

import { join, relative } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import {
  deny,
  runGate,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
  writtenPathOf,
} from '../../lib/hook-io.mjs';
import {
  isReadOnlyCommand,
  isSelfRemedyCommand,
} from '../../lib/shell-safety.mjs';
import { blocksCaller, ownedPathsOf, ownerOf } from '../../lib/task-claims.mjs';

const GATE_ID = 'file-ownership';
const CONFIG_KEY = 'blockWritesToClaimedFiles';

const ACTIVE_TASKS_FILE = join('.ai', 'tasks', 'active.json');
const ACTIVE_STATUSES = new Set(['open', 'in_forge', 'blocked']);
const RELATIVE_PREFIX = './';

function readActiveTasks(root) {
  const parsed = readJsonOrNull(join(root, ACTIVE_TASKS_FILE));
  const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  return tasks.filter((task) => task && typeof task === 'object');
}

function normalize(path) {
  let text = String(path ?? '').replaceAll('\\', '/');
  if (text.startsWith(RELATIVE_PREFIX))
    text = text.slice(RELATIVE_PREFIX.length);
  // Porque un regex de cola (`/\/+$/`) backtrackea de forma super-lineal, se recorta en bucle.
  while (text.endsWith('/')) text = text.slice(0, -1);
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function projectRelative(root, path) {
  const text = String(path ?? '');
  if (text === '') return '';
  const candidate = relative(root, join(root, text));
  // Porque una ruta que se sale del root está fuera del proyecto, y el `owns` de una tarea
  // solo puede nombrar rutas de dentro, se descarta en vez de compararla.
  return candidate.startsWith('..') ? '' : normalize(candidate);
}

function claimCovers(owned, written) {
  // Porque reclamar un directorio sin cubrir su contenido no protegería nada, una reserva
  // sobre `src/lib` alcanza cuanto cuelga de él.
  return written === owned || written.startsWith(`${owned}/`);
}

function everyWrittenPath(toolName, toolInput) {
  const paths = [];
  const direct = writtenPathOf(toolInput);
  if (direct) paths.push(direct);
  if (toolInGroups(toolName, ['shell'])) {
    paths.push(...shellWrittenPaths(shellCommandOf(toolInput)));
  }
  return paths;
}

function conflictFor(tasks, caller, writtenPaths, root) {
  for (const task of tasks) {
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    if (blocksCaller(task, caller, Date.now(), root)) continue;
    for (const owned of ownedPathsOf(task).map(normalize)) {
      const hit = writtenPaths.find((path) => claimCovers(owned, path));
      if (hit) return { task, owned, path: hit };
    }
  }
  return null;
}

function denyMessage({ task, owned, path }) {
  return (
    `\`${path}\` is claimed by another agent: task ${task.id} ("${task.title}") owns ` +
    `\`${owned}\` and is held by ${ownerOf(task)} since ${task.claimedAt}. Two agents editing ` +
    'one file is the collision this whole ownership scheme exists to prevent, so this write ' +
    'is refused rather than merged blind.\nWhat to do instead:\n' +
    '  - Work on a file nobody claimed — `claude-gates task list --free` shows what is open.\n' +
    `  - If that agent is gone, its claim expires on its own; \`claude-gates task claim ${task.id}\` ` +
    'takes it once it does.\n' +
    '  - If the change genuinely belongs together, ask that agent to release it ' +
    `(\`claude-gates task release ${task.id}\`).`
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {},
  },
  ({ toolName, toolInput, sessionId, cwd }) => {
    if (!toolInGroups(toolName, ['write', 'shell'])) return;

    // Invariante que cumple cada gate: diagnosticar y el remedio propio nunca se deniegan.
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
    const writtenPaths = everyWrittenPath(toolName, toolInput)
      .map((path) => projectRelative(root, path))
      .filter(Boolean);
    if (writtenPaths.length === 0) return;

    const conflict = conflictFor(
      readActiveTasks(root),
      sessionId,
      writtenPaths,
      root,
    );
    if (conflict) deny(CONFIG_KEY, denyMessage(conflict));
  },
);
