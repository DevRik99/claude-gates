// session-tasks — SessionStart hook. Runs once when a session opens. Lists this project's
// ACTIVE tasks (open/blocked/in_forge) so a fresh session (or one that just compacted) does
// not lose track of what was already registered. Silent when there is nothing active: this
// hook only speaks when it has something worth saying.
//
// Self-contained: Node built-ins + the task-store lib only, no npm at runtime.
//
// justification: no existing tool covers this. task-store.mjs (and its audit) already
// exists; this is the SessionStart wiring on top of it, mirroring register-requests.mjs's
// UserPromptSubmit wiring for the same store.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openTaskStore, STATUS } from './lib/task-store.mjs';

const STDIN_FILE_DESCRIPTOR = 0;
const SESSION_START_EVENT = 'SessionStart';
const CONFIG_KEY = 'listTasksOnSessionStart';
const MAX_TASKS_SHOWN = 20;

// Same config lookup as register-requests.mjs: project overrides global. Kept local so this
// plugin stays independent of the gates plugin.
const PROJECT_ROOT_MARKERS = ['.git', '.ai'];
const PROJECT_CONFIG = join('.ai', 'config.json');
const GLOBAL_CONFIG = join('.claude', 'claude-gates', 'config.json');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function projectRootOf(startDirectory) {
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

/** The tasks gate config entry (project overrides global), or null. */
function sessionTasksConfig(startDirectory) {
  const root = projectRootOf(startDirectory);
  const projectData = root ? readJson(join(root, PROJECT_CONFIG)) : null;
  const globalData = readJson(join(homedir(), GLOBAL_CONFIG));
  const layer = projectData?.gates ?? globalData?.gates ?? {};
  const entry = layer[CONFIG_KEY];
  if (typeof entry === 'boolean') return { enabled: entry };
  if (entry && typeof entry === 'object') return entry;
  return null;
}

function readPayload() {
  try {
    return JSON.parse(readFileSync(STDIN_FILE_DESCRIPTOR, 'utf8'));
  } catch {
    return {};
  }
}

function formatActiveTasks(tasks) {
  const shown = tasks.slice(0, MAX_TASKS_SHOWN);
  const lines = shown.map((task) => {
    const marker = task.status === STATUS.IN_FORGE ? ' (in_forge)' : '';
    return `  - ${task.id}: ${task.title} [${task.status}]${marker}`;
  });
  const extra = tasks.length - shown.length;
  if (extra > 0) lines.push(`  - …and ${extra} more`);
  return `[tasks] Active tasks for this project:\n${lines.join('\n')}`;
}

function speak(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: SESSION_START_EVENT,
        additionalContext: context,
      },
    }),
  );
}

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();

  const config = sessionTasksConfig(cwd);
  if (config && config.enabled === false) return; // gate turned off for this project

  const store = openTaskStore(cwd);
  if (!store) return; // no project: nowhere to track

  const tasks = store.active();
  if (tasks.length === 0) return; // nothing active: stay silent

  speak(formatActiveTasks(tasks));
}

main();
