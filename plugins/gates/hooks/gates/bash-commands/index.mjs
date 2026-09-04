// bash-commands — denies destructive shell commands (recursive force delete over a protected
// area, git reset --hard, force push, git clean -f, kill-by-name) on a real shell call and on
// a delegation prompt that ORDERS one. Deliberate limits: a delete target built from a
// variable (`rm -rf $DIR`) is not resolved, and a prompt that only mentions a command
// (negated, audited, reported) is not an order. Remote publishing lives in
// block-remote-publish so it carries its own flag.

import { hasRealCommandIntent } from '../../lib/delegation.mjs';
import { normalizeGitCommand } from '../../lib/git.mjs';
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

const GATE_ID = 'bash-commands';
const CONFIG_KEY = 'blockDestructiveShellCommands';

const DEFAULT_RM_RF_PROTECTED_AREAS = ['/', '*', 'src', 'tests'];
const DEFAULT_DENY_REASON = 'Destructive command is not allowed.';

const KILL_BY_NAME_REMEDY =
  'Killing processes by NAME reaches everything with that name, not just yours. ' +
  'Keep the PID you started and kill that; if lost, find it by its full command line ' +
  'and confirm it is yours before touching it.';

// A short-flag cluster carrying `f` (`-f`, `-fu`) or the long `--force`, but never the safe
// `--force-with-lease` / `--force-if-includes`.
const FORCE_FLAG = String.raw`(?:\s--force(?![\w-])|\s-[a-z]*f[a-z]*(?=\s|$))`;

const DEFAULT_DENY_PATTERNS = [
  [
    String.raw`\bgit\s+reset\b[^;&|]*--hard\b`,
    "'git reset --hard' discards uncommitted work for good. Use 'git stash' or " +
      "'git reset --soft', or ask the user to authorize the hard reset explicitly.",
  ],
  [
    String.raw`\bgit\s+push\b[^;&|]*(?:${FORCE_FLAG}|\s\+\S)`,
    "'git push --force' (also -f and a +refspec) rewrites remote history. Use " +
      "'--force-with-lease' if a forced update is really needed, with the user's authorization.",
  ],
  [
    String.raw`\bgit\s+clean\b[^;&|]*${FORCE_FLAG}`,
    "'git clean -f' deletes untracked files for good. Run 'git clean -n' to list them " +
      'and delete specific paths instead.',
  ],
  [
    '\\btaskkill(?:\\.exe)?\\b[^|;&]*\\s[/-]im\\b|\\bpkill\\s|\\bkillall\\s',
    KILL_BY_NAME_REMEDY,
  ],
  [
    '\\bStop-Process\\b[^|;\\n]*\\s-n(?:a(?:me?)?)?\\b|' +
      '\\bGet-Process\\b[^|;\\n]*\\|\\s*(?:Stop-Process|kill|spps)\\b',
    `Stop-Process by name (or piped from Get-Process): ${KILL_BY_NAME_REMEDY}`,
  ],
];

const INTERPRETER_EVAL_PATTERN =
  /\b(node|python3?|deno|bun)\b(?:\s+-\S+)*?\s+(?:-e|-c|--eval|--print|-p)\b/i;
const RAW_FILE_OPS_PATTERN =
  /\b(writeFileSync|readFileSync|appendFileSync|fs\.writeFile|fs\.readFile|fs\.unlink|fs\.mkdir)\b/;

function checkEmbeddedInterpreter(command) {
  const match = INTERPRETER_EVAL_PATTERN.exec(command);
  if (!match) return null;
  if (match[1].toLowerCase().startsWith('python')) {
    return 'Inline Python is not allowed in this harness: write the script to a file with Write and run that.';
  }
  const inline = command.slice(match.index + match[0].length);
  if (RAW_FILE_OPS_PATTERN.test(inline)) {
    return 'Inline interpreter doing a raw file operation (read/write/delete/mkdir). Use Write/Edit/Read instead.';
  }
  return null;
}

// ── rm -rf over a protected area ────────────────────────────────────────────────────
const RM_INVOCATION_PATTERN = /(?:^|[\s;&|(`$'"])(rm\s+([^;&|\n)`]*))/gi;
const ARGUMENT_PATTERN = /"([^"]*)"|'([^']*)'|(\S+)/g;

function isRecursiveFlag(token) {
  return (
    token === '--recursive' || (!token.startsWith('--') && /r/i.test(token))
  );
}

function isForceFlag(token) {
  return (
    token === '--force' || (!token.startsWith('--') && token.includes('f'))
  );
}

function stripTrailingQuotes(token) {
  let stripped = token;
  while (stripped.endsWith('"') || stripped.endsWith("'"))
    stripped = stripped.slice(0, -1);
  return stripped;
}

function rmArguments(argumentText) {
  const flags = { recursive: false, force: false };
  const targets = [];
  let optionsEnded = false;
  for (const match of argumentText.matchAll(ARGUMENT_PATTERN)) {
    const token = match[1] ?? match[2] ?? stripTrailingQuotes(match[3]);
    if (optionsEnded || !token.startsWith('-') || token === '-') {
      targets.push(token);
    } else if (token === '--') {
      optionsEnded = true;
    } else {
      flags.recursive ||= isRecursiveFlag(token);
      flags.force ||= isForceFlag(token);
    }
  }
  return { recursiveForce: flags.recursive && flags.force, targets };
}

function normalizeTarget(path) {
  let normalized = String(path).replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith('/'))
    normalized = normalized.slice(0, -1);
  return normalized;
}

function hitsArea(target, area) {
  if (area === '/') return target === '/' || target === '/*';
  return target === area || target.startsWith(`${area}/`);
}

function protectedRecursiveDeletes(command, areas) {
  const normalizedAreas = areas.map(normalizeTarget).filter(Boolean);
  if (normalizedAreas.length === 0) return [];
  const hits = [];
  for (const match of String(command).matchAll(RM_INVOCATION_PATTERN)) {
    const { recursiveForce, targets } = rmArguments(match[2]);
    if (!recursiveForce) continue;
    const target = targets
      .map(normalizeTarget)
      .find((candidate) =>
        normalizedAreas.some((area) => hitsArea(candidate, area)),
      );
    if (target !== undefined) hits.push({ text: match[1].trim(), target });
  }
  return hits;
}

function rmReason(hit, areas) {
  return (
    `'${hit.text}' would wipe '${hit.target}', a protected area (${areas.join(', ')}). ` +
    'Delete a specific path inside it instead, or edit rmRfProtectedAreas under ' +
    `${CONFIG_KEY} in .ai/config.json.`
  );
}

// ── Rules ───────────────────────────────────────────────────────────────────────────
function destructiveRules(parameters) {
  return normalizeRulePairs(parameters.denyPatterns, DEFAULT_DENY_REASON)
    .map(({ source, reason }) => ({ pattern: compileRegex(source), reason }))
    .filter((rule) => rule.pattern !== null);
}

function checkShellCommand(command, parameters) {
  const normalized = normalizeGitCommand(command);
  for (const { pattern, reason } of destructiveRules(parameters)) {
    const match = pattern.exec(normalized);
    if (match) deny(CONFIG_KEY, `${reason} (matched: "${match[0].trim()}")`);
  }
  const [hit] = protectedRecursiveDeletes(
    command,
    parameters.rmRfProtectedAreas,
  );
  if (hit) deny(CONFIG_KEY, rmReason(hit, parameters.rmRfProtectedAreas));
  if (parameters.embeddedInterpreterEnabled) {
    const reason = checkEmbeddedInterpreter(command);
    if (reason) deny(CONFIG_KEY, reason);
  }
}

const DELEGATION_REMEDY =
  'The delegation prompt orders this command; a subagent must not run it either. ' +
  'If the prompt only describes or forbids it, say so in the same sentence.';

function checkDelegationPrompt(prompt, parameters) {
  const normalized = normalizeGitCommand(prompt);
  for (const { pattern, reason } of destructiveRules(parameters)) {
    if (hasRealCommandIntent(normalized, pattern))
      deny(CONFIG_KEY, `${reason} ${DELEGATION_REMEDY}`);
  }
  const areas = parameters.rmRfProtectedAreas;
  for (const hit of protectedRecursiveDeletes(prompt, areas)) {
    const mention = new RegExp(escapeRegExp(hit.text), 'i');
    if (hasRealCommandIntent(prompt, mention))
      deny(CONFIG_KEY, `${rmReason(hit, areas)} ${DELEGATION_REMEDY}`);
  }
  if (parameters.embeddedInterpreterEnabled) {
    const reason = checkEmbeddedInterpreter(prompt);
    if (reason && hasRealCommandIntent(prompt, INTERPRETER_EVAL_PATTERN))
      deny(CONFIG_KEY, reason);
  }
}

// toolInputOf reduces a bare-string tool_input to {}, which would let a command sent in that
// shape through unread; the raw payload still carries it.
function shellCommandFrom(rawPayload, toolInput) {
  const command = shellCommandOf(toolInput);
  if (command) return command;
  try {
    const rawInput = JSON.parse(rawPayload)?.tool_input;
    return typeof rawInput === 'string' ? rawInput : '';
  } catch {
    return '';
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      denyPatterns: DEFAULT_DENY_PATTERNS,
      rmRfProtectedAreas: DEFAULT_RM_RF_PROTECTED_AREAS,
      embeddedInterpreterEnabled: false,
    },
  },
  ({ rawPayload, toolName, toolInput, parameters }) => {
    if (toolInGroups(toolName, ['shell'])) {
      checkShellCommand(shellCommandFrom(rawPayload, toolInput), parameters);
    } else if (toolInGroups(toolName, ['delegation'])) {
      checkDelegationPrompt(delegationPromptOf(toolInput), parameters);
    }
  },
);
