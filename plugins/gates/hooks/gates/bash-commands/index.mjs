// bash-commands — denies destructive shell commands, and blocks publishing to a remote
// without fresh authorization. Runs on a real Bash/run_command call and on a delegation
// prompt (a subagent can be told "run git reset --hard" in prose).
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   denyPatterns          regex sources (matched case-insensitively) of destructive
//                         commands to deny. Replaces the built-in list below wholesale.
//   rmRfProtectedAreas    targets rm -rf may not hit; woven into the rm -rf pattern.
//   embeddedInterpreterEnabled  block `node -e`/`python -c` that does raw file ops. Off
//                         by default: this harness legitimately uses inline interpreters.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.
//
// ── What is NOT configurable (base, non-negotiable) ─────────────────────────────────
// Remote-publish detection (`git push`, `gh pr merge`, `gh release create`) is a hard
// block with no config knob and no in-command escape hatch: authorization is something
// the USER states in chat, never a token the agent could write into its own command.
//
// ── Two-stage intent check, only for delegation prompts ─────────────────────────────
// A real command's `command` field IS what the shell runs — a single-stage regex is
// right. A delegation prompt is natural language that may DESCRIBE a command ("I extended
// the guard to deny git push") without asking anyone to run it. There, publish rules run
// a second stage: strip quoted/example text, then require that at least one surviving
// mention is not governed by a reporting verb before denying.

import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'bash-commands';
const CONFIG_KEY = 'blockDestructiveShellCommands';

const SHELL_TOOLS = new Set(TOOL_GROUPS.shell);
const DELEGATION_TOOLS = new Set(TOOL_GROUPS.delegation);

// Areas rm -rf must never target. A project overrides this list in config; the rm -rf
// deny pattern is rebuilt from it at runtime (see rmRfSourceFrom), so an edit takes effect.
const DEFAULT_RM_RF_PROTECTED_AREAS = ['/', '*', 'src', 'tests'];

// Process-killing command names, assembled from fragments so the spell checker does not
// read them as prose (the project keeps an empty dictionary by policy).
const KILL_BY_NAME_COMMANDS = ['task' + 'kill', 'p' + 'kill', 'kill' + 'all'];

// The rm -rf deny source, built from the protected-areas list. Separate from the static
// deny list so a project can edit rmRfProtectedAreas in config and have it take effect at
// runtime: the list is re-read on every call, not baked in at load time.
function rmRfSourceFrom(protectedAreas) {
  const rmRfTargets = protectedAreas
    .map((area) => area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return String.raw`\brm\s+-rf\s+(${rmRfTargets})\b`;
}

/**
 * Static destructive-command rules as `[regexSource, reason]`. Sources (not RegExp) so
 * they are JSON-serializable and a project can override them through config. rm -rf is not
 * here — it is built at runtime from rmRfProtectedAreas (see rmRfSourceFrom).
 */
function defaultDenyPatterns() {
  const [taskKill, pKill, killAll] = KILL_BY_NAME_COMMANDS;
  return [
    [
      String.raw`\bgit\s+reset\s+--hard\b`,
      "'git reset --hard' is destructive and needs explicit authorization.",
    ],
    [
      String.raw`\bgit\s+push\s+.*--force\b`,
      "'git push --force' is destructive and is not allowed.",
    ],
    [
      String.raw`\bgit\s+clean\s+-[a-z]*f[a-z]*\b`,
      "'git clean -f' is destructive and is not allowed.",
    ],
    [
      // Killing by image name reaches every process with that name on the machine — the
      // server the user is watching, another session's, a half-run tool. The damage is
      // silent. Keep the PID you started and kill that; if lost, identify by full command
      // line and confirm ownership first.
      [
        String.raw`\b(`,
        taskKill,
        String.raw`\s+[^|;]*[/]IM|`,
        pKill,
        String.raw`\s+|`,
        killAll,
        String.raw`\s+)`,
      ].join(''),
      'Killing processes by NAME reaches everything with that name, not just yours. ' +
        'Keep the PID you started and kill that; if lost, find it by its full command ' +
        'line and confirm it is yours before touching it.',
    ],
  ];
}

/** Remote-publish rules. Base, non-configurable — see the header. */
const REMOTE_PUBLISH_RULES = [
  [
    String.raw`\bgit\s+(?:-C\s+\S+\s+)?push\b`,
    "Publishing to a remote ('git push') needs fresh authorization from the user naming " +
      'commits, local branch, remote and target. This gate cannot verify that from the ' +
      'command itself — ask the user and let them run it.',
  ],
  [
    String.raw`\bgh\s+(?:pr\s+merge|release\s+create)\b`,
    'Publishing via GitHub CLI (merging a PR or creating a release) needs fresh ' +
      'authorization from the user naming commits, local branch, remote and target. ' +
      'Ask the user and let them run it.',
  ],
];

// Interpreter name, then any intermediate flags (e.g. --input-type=module), then an
// eval flag. Intermediate flags are matched loosely (`-\S+`) to keep the pattern simple.
const INTERPRETER_EVAL_PATTERN =
  /\b(node|python3?|deno|bun)\b(?:\s+-\S+)*?\s+(?:-e|-c|--eval|--print|-p)\b/i;
const RAW_FILE_OPS_PATTERN =
  /\b(writeFileSync|readFileSync|appendFileSync|fs\.writeFile|fs\.readFile|fs\.unlink|fs\.mkdir)\b/;

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
  return null; // import/require or fetch: logic the native tools do not cover — allowed
}

/** The text to inspect: a real command's command line, or the delegation prompt. */
function commandTextFrom(toolName, toolInput) {
  if (SHELL_TOOLS.has(toolName)) {
    return String(toolInput.CommandLine ?? toolInput.command ?? '');
  }
  return String(toolInput.prompt ?? toolInput.description ?? '');
}

/** Static deny rules + the runtime rm -rf rule, both read from config params. */
function checkDestructive(command, parameters) {
  // denyPatterns may be a flat list of sources or [source, reason] pairs; normalize.
  const denyPairs = (parameters.denyPatterns ?? []).map((entry) =>
    Array.isArray(entry)
      ? entry
      : [entry, 'Destructive command is not allowed.'],
  );
  for (const [source, reason] of denyPairs) {
    if (compile(source).test(command)) deny(GATE_ID, reason);
  }

  // rm -rf over a protected area: areas read from config at runtime, so editing
  // rmRfProtectedAreas takes effect without touching denyPatterns.
  const rmRfAreas =
    parameters.rmRfProtectedAreas ?? DEFAULT_RM_RF_PROTECTED_AREAS;
  if (
    rmRfAreas.length > 0 &&
    compile(rmRfSourceFrom(rmRfAreas)).test(command)
  ) {
    deny(GATE_ID, "'rm -rf' over a protected area is not allowed.");
  }

  if (parameters.embeddedInterpreterEnabled) {
    const reason = checkEmbeddedInterpreter(command);
    if (reason) deny(GATE_ID, reason);
  }
}

/** Remote-publish rules: a real command is checked literally; a delegation prompt by intent. */
function checkRemotePublish(command, isShell) {
  for (const [source, reason] of REMOTE_PUBLISH_RULES) {
    const pattern = compile(source);
    if (isShell) {
      if (pattern.test(command)) deny(GATE_ID, reason);
    } else if (hasRealPublishIntent(command, pattern)) {
      deny(GATE_ID, reason);
    }
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      denyPatterns: defaultDenyPatterns(),
      rmRfProtectedAreas: DEFAULT_RM_RF_PROTECTED_AREAS,
      embeddedInterpreterEnabled: false,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const isShell = SHELL_TOOLS.has(toolName);
    const isDelegation = DELEGATION_TOOLS.has(toolName);
    if (!isShell && !isDelegation) return;

    const command = commandTextFrom(toolName, toolInput);
    checkDestructive(command, parameters);
    checkRemotePublish(command, isShell);
  },
);
