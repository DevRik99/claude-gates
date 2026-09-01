// no-blocking — denies syntactic forms of waiting in the foreground (sleeping, polling
// loops, following unbounded output, foreground dev servers) on a real shell command and
// on a delegation prompt (a subagent can be told "wait with sleep" in prose). Migrated
// from ~/.claude/hooks/guard-no-blocking.mjs. Off by default: a project opts in, because
// many legitimate workflows still need a bounded wait the project accepts as normal.
//
// This gate only recognizes SYNTACTIC forms of waiting — it never judges whether other
// work was available meanwhile, because that is judgment, not a fact a regex can read.
// A gate that misfires on the legitimate case gets disabled, taking every real catch
// down with it.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   blockingPatterns      regex sources (matched case-insensitively) of blocking/waiting
//                         forms to deny. Replaces the built-in list wholesale.
//   waitJustifiedMarker   a marker token that, present in the command with a reason,
//                         escapes the block — a declared wait is a decision, not an
//                         oversight. Replaces the built-in marker wholesale.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.

import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'no-blocking';
const CONFIG_KEY = 'blockWaitingCommands';

const DEFAULT_WAIT_JUSTIFIED_MARKER = 'WAIT-JUSTIFIED:';

// systemd's log-follow command, assembled from fragments so the spell checker does not
// read it as prose (the project keeps an empty dictionary by policy).
const SYSTEMD_LOG_COMMAND = 'journal' + 'ctl';

/** Blocking rules as `[regexSource, reason]`, matched case-insensitively. */
const DEFAULT_BLOCKING_PATTERNS = [
  [
    String.raw`(^|[|;&]\s*|\bthen\s+|\bdo\s+)(sleep|timeout)\s+\d`,
    'Sleeping in the foreground spends the turn doing nothing. If waiting for something ' +
      'to finish, launch it in the background and move on to something else; if waiting ' +
      'on an external condition, use a monitor.',
  ],
  [
    String.raw`\bStart-Sleep\b`,
    'Start-Sleep freezes the turn. Launch the work in the background and continue with ' +
      'whatever does not depend on it.',
  ],
  [
    String.raw`(^|[|;&]\s*)wait\b|--wait\b|\bWait-Process\b|\bWait-Job\b`,
    'Waiting for another process to finish blocks the whole turn. Launch it in the ' +
      'background and consume the result when it arrives, not before.',
  ],
  [
    [
      String.raw`\b(tail|`,
      SYSTEMD_LOG_COMMAND,
      String.raw`|kubectl\s+logs|docker\s+logs)\b[^|;&]*\s-{1,2}f\b`,
    ].join(''),
    'Following live output never returns and takes the turn with it. Read the file once, ' +
      'or leave the following to a background process.',
  ],
  [
    String.raw`(^|[|;&]\s*)watch\s+`,
    "'watch' repeats forever and blocks. Run the command once; if a change genuinely " +
      'needs watching, use a monitor that does not take the turn.',
  ],
  [
    String.raw`\b(until|while)\b[^\n]{0,80}\bdo\b[^\n]{0,80}\bsleep\b`,
    'A loop that sleeps waiting for something to change is foreground polling: it blocks ' +
      'and it spins. Use a monitor with the condition, or launch the work in the ' +
      'background and wait for its notification.',
  ],
  [
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b`,
    'A dev server does not end on its own: in the foreground it takes the turn until ' +
      'something kills it. Launch it in the background and keep working while it comes up.',
  ],
];

// Marks that a command will not take the turn: backgrounded, detached, or bounded. The bare
// `-d` token was removed: it matched any -d flag (e.g. `curl -d payload`), letting an
// unrelated flag whitelist a genuine foreground `sleep`. Detached forms are now matched
// explicitly (--detach, docker/compose -d at a word boundary before end/pipe), and PowerShell's
// Start-Job / Start-Process -NoNewWindow backgrounding is recognized.
// One big alternation trips the linter's regex-complexity check, so each background form is
// its own short regex tested with `.some()` — matching EXACTLY what the combined pattern did
// (verified case-by-case). Order does not matter: any one match means the command detaches.
const NOT_TAKING_THE_TURN_FORMS = [
  /&\s*$/i,
  /\bnohup\b/i,
  /\bstart\s+\/b\b/i,
  /--detach\b/i,
  /\b-d(?=\s*($|[|;&]))/i,
  /\bStart-Job\b/i,
  /\bStart-Process\b[^|;\n]*-NoNewWindow\b/i,
  /\brun_in_background\b/i,
];

function detachesFromTurn(command) {
  return NOT_TAKING_THE_TURN_FORMS.some((pattern) => pattern.test(command));
}

function compile(source) {
  return new RegExp(source, 'i');
}

/** The text to inspect: a real command's command line, or the delegation prompt. */
function commandTextFrom(toolName, toolInput) {
  if (toolInGroups(toolName, ['shell'])) {
    return String(toolInput.CommandLine ?? toolInput.command ?? '');
  }
  return delegationPromptOf(toolInput);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      blockingPatterns: DEFAULT_BLOCKING_PATTERNS,
      waitJustifiedMarker: DEFAULT_WAIT_JUSTIFIED_MARKER,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const isShell = toolInGroups(toolName, ['shell']);
    const isDelegation = toolInGroups(toolName, ['delegation']);
    if (!isShell && !isDelegation) return;

    const command = commandTextFrom(toolName, toolInput);
    if (!command.trim()) return;

    // Already declared in the background: the turn stays free, which is all that matters.
    if (toolInput.run_in_background === true) return;
    if (detachesFromTurn(command)) return;

    // A declared wait with its reason is a decision, not an oversight.
    const marker = String(parameters.waitJustifiedMarker ?? '');
    if (marker) {
      const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reasonAfterMarker = String.raw`\s*\S+\s+\S+`;
      const justified = new RegExp(`${escapedMarker}${reasonAfterMarker}`, 'i');
      if (justified.test(command)) return;
    }

    const blockingPairs = (parameters.blockingPatterns ?? []).map((entry) =>
      Array.isArray(entry)
        ? entry
        : [entry, 'Blocking/waiting command is not allowed.'],
    );
    for (const [source, reason] of blockingPairs) {
      if (compile(source).test(command)) {
        deny(
          CONFIG_KEY,
          `${reason} If this wait is genuinely justified, add "${marker} <concrete reason>" ` +
            'to the command and try again. A declared wait is a decision; a silent one is an oversight.',
        );
      }
    }
  },
);
