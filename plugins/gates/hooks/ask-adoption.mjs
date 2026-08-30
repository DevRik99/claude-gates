// ask-adoption — SessionStart hook. In a project that has never answered the adoption
// question (no `.ai/config.json` and no recorded "asked" marker), asks the ASSISTANT to
// ask the USER what to adopt — a SessionStart hook cannot itself pop a question (there is
// no decision surface on this event), so the only legitimate move is to inject
// additionalContext asking the model to raise it, exactly once.
//
// The hook does NOT depend on the model actually asking for its own correctness: the
// deterministic half is the "have we already asked" marker, which THIS hook writes itself
// (see markAsked below) the moment it speaks — not something it waits on the model to
// report back. That guarantees the question is offered at most once per project even if
// the model never follows up.
//
// "Already answered" is either of:
//   - `.ai/config.json` exists (any content — the project already ran `init`, or has an
//     explicit config; both count as "answered", including a deliberate `adopted: false`).
//   - `.ai/.adoption-asked` exists (written by this hook after it spoke once, for the case
//     where the assistant never ran `init` — so the question is not repeated every session).
//
// justification: no existing tool covers this. `ask-adoption` was declared in registry.json
// (session family) with no script; this is that missing wiring, mirroring `session-tasks.mjs`
// and `register-requests.mjs`'s "hook asks, model judges" pattern for the tasks plugin.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STDIN_FILE_DESCRIPTOR = 0;
const SESSION_START_EVENT = 'SessionStart';
const CONFIG_KEY = 'askAdoptionInNewProject';
const PROJECT_STATE_DIRECTORY = '.ai';
const CONFIG_FILE = 'config.json';
const ASKED_MARKER_FILE = '.adoption-asked';

// Same config lookup as the other session hooks: kept local, dependency-free.
const PROJECT_ROOT_MARKERS = ['.git', PROJECT_STATE_DIRECTORY];
const GLOBAL_CONFIG = join('.claude', 'claude-gates', 'config.json');

const BOM_CHAR_CODE = 0xfeff;

/** Strips a UTF-8 BOM a Windows editor/tool may have written before the JSON. */
function stripBom(text) {
  return text.charCodeAt(0) === BOM_CHAR_CODE ? text.slice(1) : text;
}

function readJson(path) {
  try {
    return JSON.parse(stripBom(readFileSync(path, 'utf8')));
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

/** The ask-adoption gate config entry (project overrides global), or null. */
function adoptionConfig(startDirectory, projectRoot) {
  const projectData = projectRoot
    ? readJson(join(projectRoot, PROJECT_STATE_DIRECTORY, CONFIG_FILE))
    : null;
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

/** Writes the "already asked" marker so this project is never asked again. */
function markAsked(projectRoot) {
  try {
    mkdirSync(join(projectRoot, PROJECT_STATE_DIRECTORY), { recursive: true });
    writeFileSync(
      join(projectRoot, PROJECT_STATE_DIRECTORY, ASKED_MARKER_FILE),
      `${new Date().toISOString()}\n`,
    );
  } catch {
    // If the marker can't be written, worst case the question is offered again next
    // session — not a correctness break, just a repeat.
  }
}

const ADOPTION_PROMPT =
  '[ask-adoption] This project has not adopted claude-gates yet (no .ai/config.json found). ' +
  'Ask the user, once, whether they want to adopt it and with which mode: ' +
  '"defaults" (recommended gates only), "all" (every gate in every family), or "none" ' +
  '(record a no so this is not asked again). Record whatever they choose by running ' +
  '`claude-gates init --<mode> --yes` (add --project or --global for scope) from the ' +
  'project root — that CLI run is what actually persists the decision.';

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();
  const projectRoot = projectRootOf(cwd) ?? cwd;

  const config = adoptionConfig(cwd, projectRoot);
  if (config && config.enabled === false) return; // gate turned off for this project

  const configPath = join(projectRoot, PROJECT_STATE_DIRECTORY, CONFIG_FILE);
  if (existsSync(configPath)) return; // already answered (init ran, or an explicit config)

  const markerPath = join(
    projectRoot,
    PROJECT_STATE_DIRECTORY,
    ASKED_MARKER_FILE,
  );
  if (existsSync(markerPath)) return; // already asked once; do not repeat

  speak(ADOPTION_PROMPT);
  markAsked(projectRoot);
}

try {
  main();
} catch {
  // A broken ask-adoption hook must never block session start.
}
