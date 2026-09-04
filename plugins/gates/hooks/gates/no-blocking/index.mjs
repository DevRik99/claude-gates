// no-blocking — denies syntactic forms of waiting in the foreground (sleeping, polling loops,
// following unbounded output, foreground dev servers, Windows pauses) on a real shell command
// and on a delegation prompt that orders one. Off by default: a project opts in. Deliberate
// limits: only SYNTACTIC waiting is recognized, never whether other work was available
// meanwhile; each command segment is judged on its own, so a detach form (`&`, nohup,
// Start-Job, --detach) exempts only the segment it is in, and only the real
// `run_in_background: true` flag exempts the whole call — the words in the command do not.

import { hasRealCommandIntent } from '../../lib/delegation.mjs';
import {
  compileRegex,
  delegationPromptOf,
  deny,
  escapeRegExp,
  normalizeRulePairs,
  runGate,
  shellCommandOf,
  toolInGroups,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'no-blocking';
const CONFIG_KEY = 'blockWaitingCommands';

const DEFAULT_WAIT_JUSTIFIED_MARKER = 'WAIT-JUSTIFIED:';
const DEFAULT_REASON = 'Blocking/waiting command is not allowed.';

// Where a command may begin inside a segment or a sentence: the start, after a control word,
// or after a separator a prompt may still carry.
const COMMAND_START = String.raw`(?:^|[|;&(]\s*|\b(?:then|do|else)\s+)`;
const FOLLOW_COMMANDS =
  '(?:tail|journalctl|kubectl\\s+logs|docker(?:-compose|\\s+compose)?\\s+logs)';

const DEFAULT_BLOCKING_PATTERNS = [
  [
    `${COMMAND_START}sleep\\s`,
    'Sleeping in the foreground spends the turn doing nothing. If waiting for something ' +
      'to finish, launch it in the background and move on to something else; if waiting ' +
      'on an external condition, use a monitor.',
  ],
  [
    `${COMMAND_START}timeout(?:\\.exe)?\\s+(?:/t\\s+)?\\d+(?:\\s+/nobreak)?\\s*$`,
    "'timeout N' with no command is a sleep. Wrap a real command (timeout 120 npm test) " +
      'or launch the wait in the background.',
  ],
  [
    String.raw`\bStart-Sleep\b`,
    'Start-Sleep freezes the turn. Launch the work in the background and continue with ' +
      'whatever does not depend on it.',
  ],
  [
    String.raw`${COMMAND_START}wait\b|\s--wait\b|\bWait-Process\b|\bWait-Job\b|\bStart-Process\b[^|;\n]*\s-Wait\b`,
    'Waiting for another process to finish blocks the whole turn. Launch it in the ' +
      'background and consume the result when it arrives, not before.',
  ],
  [
    String.raw`\b${FOLLOW_COMMANDS}\b[^|;&\n]*\s(?:-[a-z]*f[a-z]*|--follow)(?=\s|$)`,
    'Following live output never returns and takes the turn with it. Read the file once, ' +
      'or leave the following to a background process.',
  ],
  [
    `${COMMAND_START}watch\\s+`,
    "'watch' repeats forever and blocks. Run the command once; if a change genuinely " +
      'needs watching, use a monitor that does not take the turn.',
  ],
  [
    String.raw`\b(?:until|while)\b[\s\S]{0,80}\bdo\b[\s\S]{0,80}\bsleep\b`,
    'A loop that sleeps waiting for something to change is foreground polling: it blocks ' +
      'and it spins. Use a monitor with the condition, or launch the work in the ' +
      'background and wait for its notification.',
  ],
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)(?=\s|$)`,
    'A dev server does not end on its own: in the foreground it takes the turn until ' +
      'something kills it. Launch it in the background and keep working while it comes up.',
  ],
  [
    String.raw`${COMMAND_START}ping\b[^|;&\n]*\s-n\s+\d{2,}\b|${COMMAND_START}pause\b|\bRead-Host\b`,
    'A ping loop, pause or Read-Host waits on the clock or on a keyboard nobody is at. ' +
      'Remove the wait; if something must be awaited, do it in the background.',
  ],
];

// ── Shell segments ──────────────────────────────────────────────────────────────────
// A lone `&` backgrounds the segment before it; `>&` and `&>` are redirections, not separators.
const SEPARATOR_PATTERN = /(\|\||&&|\||;|\n|(?<!>)&(?![&>]))/;
const SHELL_WRAPPER_PATTERN =
  /^(?:sh|bash|zsh|dash|ksh)\s+(-\w+)\s+(?:"([^"]*)"|'([^']*)')/i;
const DETACHED_SEGMENT_FORMS = [
  /\bnohup\b/i,
  /\bstart\s+\/b\b/i,
  /--detach\b/i,
  /^docker(?:-compose|\s+compose)?\b[^|;\n]*\s-d(?=\s|$)/i,
  /\bStart-Job\b/i,
];

function stripGrouping(text) {
  let stripped = text.trim();
  while (stripped.startsWith('(') || stripped.startsWith('$('))
    stripped = stripped.replace(/^\$?\(/, '').trim();
  while (stripped.endsWith(')')) stripped = stripped.slice(0, -1).trimEnd();
  return stripped;
}

function shellSegments(command) {
  const parts = String(command).split(SEPARATOR_PATTERN);
  const segments = [];
  for (let index = 0; index < parts.length; index += 2) {
    const text = stripGrouping(parts[index]);
    if (!text) continue;
    const sentToBackground = parts[index + 1] === '&';
    const wrapped = SHELL_WRAPPER_PATTERN.exec(text);
    if (wrapped && wrapped[1].includes('c')) {
      for (const inner of shellSegments(wrapped[2] ?? wrapped[3]))
        segments.push({
          text: inner.text,
          detached: sentToBackground || inner.detached,
        });
      continue;
    }
    const detached =
      sentToBackground ||
      DETACHED_SEGMENT_FORMS.some((form) => form.test(text));
    segments.push({ text, detached });
  }
  return segments;
}

// ── Rules ───────────────────────────────────────────────────────────────────────────
function blockingRules(parameters) {
  return normalizeRulePairs(parameters.blockingPatterns, DEFAULT_REASON)
    .map(({ source, reason }) => ({ pattern: compileRegex(source), reason }))
    .filter((rule) => rule.pattern !== null);
}

function isJustified(text, marker) {
  if (!marker) return false;
  const reasonAfterMarker = String.raw`\s*\S+\s+\S+`;
  return new RegExp(`${escapeRegExp(marker)}${reasonAfterMarker}`, 'i').test(
    text,
  );
}

function denyBlocking(reason, marker, matched) {
  deny(
    CONFIG_KEY,
    `${reason} (matched: "${matched.trim()}") Launch it with run_in_background: true, or ` +
      `if this wait is genuinely justified add "${marker} <concrete reason>" to the command. ` +
      'A declared wait is a decision; a silent one is an oversight.',
  );
}

function checkShellCommand(command, parameters, marker) {
  const foreground = shellSegments(command)
    .filter((segment) => !segment.detached)
    .map((segment) => segment.text);
  if (foreground.length === 0) return;
  // The joined text lets a rule see a loop whose body sits in another segment.
  const candidates =
    foreground.length > 1 ? [...foreground, foreground.join('\n')] : foreground;
  for (const { pattern, reason } of blockingRules(parameters)) {
    for (const candidate of candidates) {
      const match = pattern.exec(candidate);
      if (match) denyBlocking(reason, marker, match[0]);
    }
  }
}

function checkDelegationPrompt(prompt, parameters, marker) {
  for (const { pattern, reason } of blockingRules(parameters)) {
    if (hasRealCommandIntent(prompt, pattern))
      denyBlocking(
        `${reason} The delegation prompt orders the wait; a subagent must not do it either.`,
        marker,
        pattern.exec(prompt)?.[0] ?? '',
      );
  }
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
    if (!isShell && !toolInGroups(toolName, ['delegation'])) return;
    const text = isShell
      ? shellCommandOf(toolInput)
      : delegationPromptOf(toolInput);
    if (!text.trim()) return;
    if (toolInput.run_in_background === true) return;

    const marker = String(parameters.waitJustifiedMarker ?? '');
    if (isJustified(text, marker)) return;

    if (isShell) checkShellCommand(text, parameters, marker);
    else checkDelegationPrompt(text, parameters, marker);
  },
);
