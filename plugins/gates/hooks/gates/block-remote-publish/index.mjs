// block-remote-publish — denies publishing to a remote (`git push`, `gh pr merge`,
// `gh release create`) without fresh human authorization. Split out of bash-commands so a
// project can let the agent push (blockRemotePublish: false) without losing the destructive
// command protections. Deliberate limits: only a command segment that RUNS git/gh is judged
// (a mention inside grep, echo or a --grep value is not a publish), a `--dry-run` push writes
// nothing, and a delegation prompt is denied only when it orders the publish rather than
// describing or forbidding it.

import { hasRealCommandIntent } from '../../lib/delegation.mjs';
import { normalizeGitCommand } from '../../lib/git.mjs';
import {
  compileRegex,
  delegationPromptOf,
  deny,
  normalizeRulePairs,
  runGate,
  shellCommandOf,
  toolInGroups,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'block-remote-publish';
const CONFIG_KEY = 'blockRemotePublish';

const AUTHORIZATION_REMEDY =
  'needs fresh authorization from the user naming commits, local branch, remote and ' +
  'target. This gate cannot verify that from the command itself — ask the user and let ' +
  'them run it. To let the agent publish on its own, set "blockRemotePublish": false in ' +
  '.ai/config.json.';

const DEFAULT_PUBLISH_RULES = [
  [
    String.raw`\bgit\s+push\b`,
    `Publishing to a remote ('git push') ${AUTHORIZATION_REMEDY}`,
  ],
  [
    String.raw`\bgh\s+(?:pr\s+merge|release\s+create)\b`,
    `Publishing via GitHub CLI (merging a PR or creating a release) ${AUTHORIZATION_REMEDY}`,
  ],
];
const DEFAULT_REASON = `Publishing to a remote ${AUTHORIZATION_REMEDY}`;

// `gh -R owner/repo pr merge` and `gh pr --repo x merge` name the repo between the words a
// rule looks for; stripping the option first keeps the rules readable.
const GH_REPO_OPTION_PATTERN =
  /(\bgh\s+(?:pr\s+|release\s+)?)(?:-R|--repo)(?:=|\s+)\S+\s+/i;

function normalizeGhCommand(text) {
  let normalized = text;
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replace(GH_REPO_OPTION_PATTERN, '$1');
  } while (normalized !== previous);
  return normalized;
}

function normalizeCommand(text) {
  return normalizeGhCommand(normalizeGitCommand(text));
}

// ── Command segments that run git/gh ────────────────────────────────────────────────
const SEGMENT_SEPARATOR = /;|&&|\|\||\||\n|\$\(|`/;
const WRAPPER_WORD_PATTERN =
  /^(?:\w+=\S*|command|sudo|exec|env|time|nohup|builtin)$/i;

function stripLeadingWrappers(segment) {
  const tokens = segment.replace(/^[\s(]+/, '').split(/\s+/);
  while (tokens.length > 0 && WRAPPER_WORD_PATTERN.test(tokens[0]))
    tokens.shift();
  return tokens.join(' ');
}

const SHELL_WRAPPER_PATTERN =
  /^(?:sh|bash|zsh|dash|ksh)\s+(-\w+)\s+(?:"([^"]*)"|'([^']*)')/i;
const QUOTED_PATTERN = /"[^"]*"|'[^']*'/g;
const PUBLISHING_BINARY_PATTERN = /^(?:git|gh)(?=\s|$)/i;

function segmentsRunningGit(command) {
  const segments = [];
  for (const rawSegment of String(command).split(SEGMENT_SEPARATOR)) {
    const segment = stripLeadingWrappers(rawSegment);
    const wrapped = SHELL_WRAPPER_PATTERN.exec(segment);
    if (wrapped && wrapped[1].includes('c')) {
      segments.push(...segmentsRunningGit(wrapped[2] ?? wrapped[3]));
    } else if (PUBLISHING_BINARY_PATTERN.test(segment)) {
      segments.push(segment.replace(QUOTED_PATTERN, ' '));
    }
  }
  return segments;
}

const DRY_RUN_PUSH_PATTERN = /\bgit\s+push\b.*(?:\s--dry-run\b|\s-n\b)/i;

function publishRules(parameters) {
  return normalizeRulePairs(parameters.publishRules, DEFAULT_REASON)
    .map(({ source, reason }) => ({ pattern: compileRegex(source), reason }))
    .filter((rule) => rule.pattern !== null);
}

function checkShellCommand(command, parameters) {
  const rules = publishRules(parameters);
  for (const segment of segmentsRunningGit(normalizeCommand(command))) {
    if (DRY_RUN_PUSH_PATTERN.test(segment)) continue;
    for (const { pattern, reason } of rules) {
      if (pattern.test(segment))
        deny(CONFIG_KEY, `${reason} (command: "${segment.trim()}")`);
    }
  }
}

function checkDelegationPrompt(prompt, parameters) {
  const normalized = normalizeCommand(prompt);
  for (const { pattern, reason } of publishRules(parameters)) {
    if (hasRealCommandIntent(normalized, pattern)) {
      deny(
        CONFIG_KEY,
        `${reason} The delegation prompt orders the publish; a subagent must not run it either.`,
      );
    }
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      publishRules: DEFAULT_PUBLISH_RULES,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (toolInGroups(toolName, ['shell'])) {
      checkShellCommand(shellCommandOf(toolInput), parameters);
    } else if (toolInGroups(toolName, ['delegation'])) {
      checkDelegationPrompt(delegationPromptOf(toolInput), parameters);
    }
  },
);
