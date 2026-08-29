// register-requests — UserPromptSubmit hook. Runs on every user message, BEFORE the
// assistant responds. It is the deterministic half of the task system: it never decides
// what is a task (that judgment is the assistant's), it only makes sure open tasks are not
// forgotten. Two jobs, both cheap and side-effect-light:
//   1. Count messages. Every `remindEvery` messages, surface a stronger reminder.
//   2. Inject the open tasks (title + status) into the assistant's context so a long or
//      compacted conversation never loses the thread of what is still pending.
//
// A UserPromptSubmit hook's stdout is added to the assistant's context as plain text, so
// the reminder is simply written to stdout. Self-contained: Node built-ins + the task-store
// lib only, no npm at runtime.
//
// justification: no existing tool covers this. The task store and the audit were done when
// task-store.mjs was written (see its header); this file is the hook wiring on top.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openTaskStore } from './lib/task-store.mjs';

const STDIN_FILE_DESCRIPTOR = 0;
const CONFIG_KEY = 'runTaskReminders';
const DEFAULT_REMIND_EVERY = 10;
const MAX_TASKS_SHOWN = 12;

// Config lookup mirrors the gates' config.mjs (project → global), kept local so this plugin
// stays independent of the gates plugin.
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
function taskConfig(startDirectory) {
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

function formatReminder(tasks, forced) {
  const shown = tasks.slice(0, MAX_TASKS_SHOWN);
  const lines = shown.map(
    (task) => `  - [${task.status}] ${task.id}: ${task.title}`,
  );
  const extra = tasks.length - shown.length;
  if (extra > 0) lines.push(`  - …and ${extra} more`);
  const header = forced
    ? 'OPEN TASKS — recite these pending tasks to the user and confirm whether any should be dropped:'
    : 'Open tasks (do not lose track of these):';
  return `[tasks] ${header}\n${lines.join('\n')}`;
}

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();

  const config = taskConfig(cwd);
  if (config && config.enabled === false) return; // gate turned off for this project

  const store = openTaskStore(cwd);
  if (!store) return; // no project: nowhere to track

  const tasks = store.active();
  if (tasks.length === 0) return; // nothing pending: stay silent

  const remindEvery = Number(config?.remindEvery) || DEFAULT_REMIND_EVERY;
  const next = store.counter() + 1;
  const forced = next >= remindEvery;
  store.setCounter(forced ? 0 : next);

  process.stdout.write(`${formatReminder(tasks, forced)}\n`);
}

main();
