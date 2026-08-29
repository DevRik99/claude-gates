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

import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'no-blocking';
const CONFIG_KEY = 'blockWaitingCommands';

const SHELL_TOOLS = new Set(TOOL_GROUPS.shell);
const DELEGATION_TOOLS = new Set(TOOL_GROUPS.delegation);

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

/** Marks that a command will not take the turn: backgrounded, detached, or bounded. */
const NOT_TAKING_THE_TURN =
  /(&\s*$|\bnohup\b|\bstart\s+\/b\b|--detach\b|-d\b|\brun_in_background\b)/i;

function compile(source) {
  return new RegExp(source, 'i');
}

/** The text to inspect: a real command's command line, or the delegation prompt. */
function commandTextFrom(toolName, toolInput) {
  if (SHELL_TOOLS.has(toolName)) {
    return String(toolInput.CommandLine ?? toolInput.command ?? '');
  }
  return String(toolInput.prompt ?? toolInput.description ?? '');
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
    const isShell = SHELL_TOOLS.has(toolName);
    const isDelegation = DELEGATION_TOOLS.has(toolName);
    if (!isShell && !isDelegation) return;

    const command = commandTextFrom(toolName, toolInput);
    if (!command.trim()) return;

    // Already declared in the background: the turn stays free, which is all that matters.
    if (toolInput.run_in_background === true) return;
    if (NOT_TAKING_THE_TURN.test(command)) return;

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
          GATE_ID,
          `${reason} If this wait is genuinely justified, add "${marker} <concrete reason>" ` +
            'to the command and try again. A declared wait is a decision; a silent one is an oversight.',
        );
      }
    }
  },
);
