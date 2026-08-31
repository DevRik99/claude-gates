// Gate smoke test: for each gate, feed it a KNOWN violation and confirm it actually reacts
// (denies / warns), not just that its file exists on disk (that is doctor.mjs's job). This
// is the check that would have caught neutral-spanish silently warning when the user expected
// a block, and stop-pending never firing on a fresh install.
//
// A gate is run as its own process, exactly as Claude Code runs it: the violation payload on
// stdin, in a scratch project so its config lookup is isolated. The gate declares in the
// fixture manifest whether it is expected to DENY or WARN, and whether it needs its config key
// enabled (gates that are off by default) — the runner writes that config into the scratch
// project before invoking.
//
// Pure of I/O policy: this module runs gates and classifies; the CLI command (index.mjs)
// owns printing. `runSmoke` returns structured results so it is testable without a terminal.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATES_DIR = join(HERE, '..', 'plugins', 'gates', 'hooks', 'gates');

// Max characters of a gate's error message to keep in the report — enough to identify the
// failure, short enough to keep the per-gate line readable.
const ERROR_MESSAGE_MAX_LENGTH = 120;
// A gate that hangs is a defect too; cap how long the smoke test waits for one to respond.
const GATE_RUN_TIMEOUT_MS = 10000;

// Outcomes the runner reports per gate.
export const OUTCOMES = Object.freeze({
  REACTED: 'reacted', // gate produced the expected deny/warn — the protection works
  NO_REACTION: 'no-reaction', // gate ran but did not react to its own known violation — DEFECT
  SKIPPED: 'skipped', // fixture needs seeded state we do not set up, or has no violation case
  ERROR: 'error', // gate threw / could not be run
});

/** A scratch project (git marker) with an optional gate config, so the run is isolated. */
function makeScratchProject(configKey, enable) {
  const project = mkdtempSync(join(tmpdir(), 'gate-smoke-'));
  mkdirSync(join(project, '.git'));
  if (enable && configKey) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(
      join(project, '.ai', 'config.json'),
      JSON.stringify({ gates: { [configKey]: { enabled: true } } }),
    );
  }
  return project;
}

/** Reads a gate's decision from its stdout. null when it allowed (no output). */
function decisionOf(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed?.hookSpecificOutput?.permissionDecision === 'deny') return 'deny';
  if (parsed?.decision === 'block') return 'deny'; // Stop-hook shape
  if (typeof parsed?.hookSpecificOutput?.additionalContext === 'string')
    return 'warn';
  return null;
}

/** Runs one gate against its fixture and classifies the outcome. */
export function runGateFixture(fixture, { gatesDirectory = GATES_DIR } = {}) {
  const { id, configKey, enabledByDefault, type, payload, needsState } =
    fixture;

  if (needsState || type === 'none' || payload == null) {
    return {
      id,
      outcome: OUTCOMES.SKIPPED,
      expected: type,
      got: null,
      reason: needsState
        ? 'needs seeded state (db/file) not set up by the smoke test'
        : 'gate has no violation case to plant (side-effect or judgment-only)',
    };
  }

  const scriptPath = join(gatesDirectory, id, 'index.mjs');
  const project = makeScratchProject(configKey, !enabledByDefault);

  let stdout;
  try {
    stdout = execFileSync(process.execPath, [scriptPath], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: project,
      env: { ...process.env, HOME: project, USERPROFILE: project },
      timeout: GATE_RUN_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      id,
      outcome: OUTCOMES.ERROR,
      expected: type,
      got: null,
      reason: String(error?.message ?? error).slice(
        0,
        ERROR_MESSAGE_MAX_LENGTH,
      ),
    };
  }

  const got = decisionOf(stdout);
  // A gate expected to deny must deny; a gate expected to warn must warn. Anything else
  // (allowed silently, or wrong reaction kind) is a no-reaction defect worth surfacing.
  const reacted = got === type;
  return {
    id,
    outcome: reacted ? OUTCOMES.REACTED : OUTCOMES.NO_REACTION,
    expected: type,
    got: got ?? 'allow',
  };
}

/** Runs the whole manifest and returns per-gate results plus a summary tally. */
export function runSmoke(manifest, options = {}) {
  const results = manifest.map((fixture) => runGateFixture(fixture, options));
  const tally = { reacted: 0, 'no-reaction': 0, skipped: 0, error: 0 };
  for (const result of results) tally[result.outcome] += 1;
  return { results, tally };
}
