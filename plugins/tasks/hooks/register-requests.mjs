// register-requests — UserPromptSubmit hook. Runs on every user message, BEFORE the
// assistant responds. It is the deterministic half of the task system: it never decides
// what is a task (that judgment is the assistant's — the hook only asks it to judge), it
// only makes sure the judgment is asked and open tasks are not forgotten. Two jobs:
//   1. On every message, ask the assistant to classify: if this message is a new task,
//      register it via `claude-gates task add` (persistence is deterministic — the store —
//      but the classification itself is the model's judgment, never a regex here).
//   2. Every `remindEveryMessages` messages (counted via the store's counter), also recite
//      the currently active tasks so a long or compacted conversation never loses the
//      thread of what is still pending.
//
// A UserPromptSubmit hook's stdout is added to the assistant's context as plain text, so
// both are simply written to stdout. Self-contained: Node built-ins + the task-store lib
// only, no npm at runtime.
//
// justification: no existing tool covers this. The task store and the audit were done when
// task-store.mjs was written (see its header); this file is the hook wiring on top.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openTaskStore } from './lib/task-store.mjs';

const STDIN_FILE_DESCRIPTOR = 0;
const CONFIG_KEY = 'remindOpenTasks';
const DEFAULT_REMIND_EVERY_MESSAGES = 5;
const MAX_TASKS_SHOWN = 12;
const DUMP_ENV = 'CLAUDE_GATES_DUMP_DEFAULTS';

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

// Asked on every message. The hook does not classify — it asks the model to, and the
// model is the one that persists (via the CLI, which enforces the store's own rules,
// e.g. evidence on close). Default to registering: the USER defines what is a task, not
// the model. The model must not use judgment to skip what the user considers actionable.
const CLASSIFY_PROMPT =
  "[remindOpenTasks] MANDATORY — before writing your reply, you MUST register the user's message as a " +
  'task unless it is UNAMBIGUOUSLY one of these: (a) pure small talk with no request ("hello", ' +
  '"thanks"), (b) a yes/no answer to a question YOU asked, (c) a message that says only "continue" ' +
  'or "go ahead". Everything else is a task — including questions that require research, review ' +
  'requests, error reports, follow-ups that add scope, corrections, and messages with multiple ' +
  'requests (register one task per distinct request). DEFAULT TO REGISTERING: when in doubt, ' +
  'register.\n\n' +
  'VERIFICATION REQUIRED: every task MUST include a deterministic verification criterion. Use ' +
  'one of these:\n' +
  '  --verify-command "<shell command>" [--verify-expect <text>]  (command must exit 0 when done)\n' +
  '  --verify-path <file-or-dir> [--verify-contains <text>]       (must exist when done)\n' +
  'Examples:\n' +
  '  claude-gates task add "Fix login bug" --verify-command "npm test -- --grep login" --verify-expect "passing"\n' +
  '  claude-gates task add "Add config file" --verify-path "src/config.ts" --verify-contains "export"\n' +
  'Pick the criterion that a machine can check: a test that passes, a file that exists, a grep ' +
  'that matches. If the task is a question/research, use --verify-path for the file where the ' +
  'answer will be written, or --verify-command "claude-gates task list" --verify-expect "done".\n\n' +
  'SPLITTING (Depth Tree): tasks with size medium or larger MUST be split into sub-tasks before ' +
  'implementation. SCOPE FIRST: if the task description is vague or you are unsure what files or ' +
  'modules are affected, ASK THE USER to clarify the scope before splitting — do not guess. ' +
  'Once scope is clear:\n' +
  '  1. Each sub-task OWNS specific files (state in --description "OWNS: <paths>") — no overlap\n' +
  '  2. Each sub-task is --size small and independently verifiable\n' +
  '  3. Split at natural boundaries: one module, one function, one test file\n' +
  '  4. Register parent first, then sub-tasks with --parent <parent-id>\n' +
  'Example:\n' +
  '  claude-gates task add "Refactor auth" --size large --verify-command "npm test" --verify-expect "passing"\n' +
  '  claude-gates task add "Extract token validation" --parent <id> --size small ' +
  '--verify-path "src/auth/validate.ts" --description "OWNS: src/auth/validate.ts"\n' +
  '  claude-gates task add "Add token refresh" --parent <id> --size small ' +
  '--verify-command "npm test -- --grep refresh" --description "OWNS: src/auth/refresh.ts"\n\n' +
  'Run `claude-gates task add "<title>" [--description <text>] [--size <size>] --verify-command|--verify-path ...` ' +
  "from the project root (or the CLI's absolute path if `claude-gates` is not on PATH). Do not defer " +
  'this, do not decide to register it "later", do not silently skip it because the answer seems ' +
  "obvious. The user's flow takes priority over your judgment of what deserves tracking.";

function formatReminder(tasks) {
  const shown = tasks.slice(0, MAX_TASKS_SHOWN);
  const lines = shown.map(
    (task) => `  - [${task.status}] ${task.id}: ${task.title}`,
  );
  const extra = tasks.length - shown.length;
  if (extra > 0) lines.push(`  - …and ${extra} more`);
  return (
    '[remindOpenTasks] OPEN TASKS — recite these pending tasks to the user and confirm whether any ' +
    `should be dropped:\n${lines.join('\n')}`
  );
}

function main() {
  // Same defaults-dump protocol as the gates plugin's runGate (see hook-io.mjs): the CLI's
  // materialize.mjs spawns this script with the env var set to read its built-in params as
  // the single source of truth, before touching stdin.
  if (process.env[DUMP_ENV]) {
    process.stdout.write(
      JSON.stringify({
        id: 'remind-open-tasks',
        configKey: CONFIG_KEY,
        enabledByDefault: true,
        defaultParams: { remindEveryMessages: DEFAULT_REMIND_EVERY_MESSAGES },
      }),
    );
    return;
  }

  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();

  const config = taskConfig(cwd);
  if (config && config.enabled === false) return; // gate turned off for this project

  const store = openTaskStore(cwd);
  if (!store) return; // no project: nowhere to track

  const lines = [CLASSIFY_PROMPT];

  const tasks = store.active();
  if (tasks.length > 0) {
    const remindEveryMessages =
      Number(config?.remindEveryMessages) || DEFAULT_REMIND_EVERY_MESSAGES;
    const next = store.counter() + 1;
    const forced = next >= remindEveryMessages;
    store.setCounter(forced ? 0 : next);
    if (forced) lines.push(formatReminder(tasks));
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
