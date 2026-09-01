// block-remote-publish — denies publishing to a remote (`git push`, `gh pr merge`,
// `gh release create`) without fresh human authorization. Split out of bash-commands so it
// carries its OWN enabled flag: a project can turn remote-publish blocking off in config
// (blockRemotePublish: false) WITHOUT losing the destructive-command protections (rm -rf,
// git reset --hard) that live in bash-commands. Nothing is hardcoded any more — this gate
// obeys its flag like every other, and appears in the CLI's gate selector on its own.
//
// Default: enabled. The safe posture is that the human states the authorization in chat,
// naming commits, branch, remote and target — a project that wants the agent to push on its
// own opts in explicitly by disabling this gate.
//
// ── Two-stage intent check, only for delegation prompts ─────────────────────────────
// A real command's `command` field IS what the shell runs — a single-stage regex is right.
// A delegation prompt is natural language that may DESCRIBE a command ("I extended the guard
// to deny git push") without asking anyone to run it. There, publish rules run a second
// stage: strip quoted/example text, then require that at least one surviving mention is not
// governed by a reporting verb before denying.

import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'block-remote-publish';
const CONFIG_KEY = 'blockRemotePublish';

// Remote-publish rules as `[regexSource, reason]`. Sources (not RegExp) so a project could
// override them through config if it ever needed to.
function defaultPublishRules() {
  return [
    [
      String.raw`\bgit\s+(?:-C\s+\S+\s+)?push\b`,
      "Publishing to a remote ('git push') needs fresh authorization from the user naming " +
        'commits, local branch, remote and target. This gate cannot verify that from the ' +
        'command itself — ask the user and let them run it. To let the agent push on its ' +
        'own, set "blockRemotePublish": false in .ai/config.json.',
    ],
    [
      String.raw`\bgh\s+(?:pr\s+merge|release\s+create)\b`,
      'Publishing via GitHub CLI (merging a PR or creating a release) needs fresh ' +
        'authorization from the user naming commits, local branch, remote and target. ' +
        'Ask the user and let them run it. To let the agent publish on its own, set ' +
        '"blockRemotePublish": false in .ai/config.json.',
    ],
  ];
}

// How far back from a mention to look for a governing verb, and the reporting-verb lexicon
// that marks a mention as description rather than an order. Only the text before a mention
// is inspected: what governs it is what precedes it (appending words after a real command
// would otherwise be a trivial bypass).
const DESCRIPTION_LOOK_BACK = 80;
const REPORTING_VERB_PATTERN =
  /(describe|explain|summar|mention|added|built|extended|denies?|deny|prohibit|protection|report|documentation|changelog)/i;

function compile(source) {
  return new RegExp(source, 'i');
}

// git's GLOBAL options sit between `git` and the subcommand: `git -C <path> push`, etc. A
// pattern that matches `git push` contiguously is evaded by any of them. Stripping these
// first — turning `git -C /repo push` back into `git push` — closes that bypass at once.
const GIT_OPTION_WITH_VALUE = String.raw`(?:-[Cc]|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:\s+|=)\S+`;
const GIT_FLAG_OPTION = String.raw`--(?:paginate|no-pager|bare|no-optional-locks)|-p`;
const GIT_GLOBAL_OPTION_PATTERN = new RegExp(
  String.raw`\bgit\s+(?:${GIT_OPTION_WITH_VALUE}|${GIT_FLAG_OPTION})\s+`,
  'i',
);

function normalizeGitOptions(command) {
  let previous;
  let normalized = command;
  do {
    previous = normalized;
    normalized = normalized.replace(GIT_GLOBAL_OPTION_PATTERN, 'git ');
  } while (normalized !== previous);
  return normalized;
}

function stripQuoted(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/"[^"\n]{0,300}"/g, ' ')
    .replace(/'[^'\n]{0,300}'/g, ' ');
}

/** True when a surviving, non-quoted mention is not governed by a reporting verb. */
function hasRealPublishIntent(text, pattern) {
  if (!pattern.test(text)) return false;
  const cleaned = stripQuoted(text);
  const global = new RegExp(
    pattern.source,
    `${pattern.flags.replace('g', '')}g`,
  );
  const matches = [...cleaned.matchAll(global)];
  if (matches.length === 0) return false;
  return matches.some((match) => {
    const from = Math.max(0, match.index - DESCRIPTION_LOOK_BACK);
    return !REPORTING_VERB_PATTERN.test(cleaned.slice(from, match.index));
  });
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
    enabledByDefault: true,
    defaultParams: {
      publishRules: defaultPublishRules(),
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const isShell = toolInGroups(toolName, ['shell']);
    const isDelegation = toolInGroups(toolName, ['delegation']);
    if (!isShell && !isDelegation) return;

    const command = commandTextFrom(toolName, toolInput);
    // For a real shell command, normalize git's global options first. For a delegation
    // prompt (free text), the intent check runs on the raw text.
    const shellCommand = normalizeGitOptions(command);
    for (const [source, reason] of parameters.publishRules) {
      const pattern = compile(source);
      if (isShell) {
        if (pattern.test(shellCommand)) deny(CONFIG_KEY, reason);
      } else if (hasRealPublishIntent(command, pattern)) {
        deny(CONFIG_KEY, reason);
      }
    }
  },
);
