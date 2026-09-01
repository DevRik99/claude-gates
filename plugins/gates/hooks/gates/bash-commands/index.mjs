// bash-commands — denies destructive shell commands (rm -rf over protected areas, git
// reset --hard, force push, kill-by-name). Runs on a real Bash/run_command call and on a
// delegation prompt (a subagent can be told "run git reset --hard" in prose).
//
// Remote-publish blocking (git push / gh pr merge / gh release create) used to live here as
// a hardcoded, non-configurable block. It was split out into the block-remote-publish gate
// so it carries its own enabled flag: a project can now allow the agent to push by disabling
// that gate WITHOUT also disabling the destructive-command protections below.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   denyPatterns          regex sources (matched case-insensitively) of destructive
//                         commands to deny. Replaces the built-in list below wholesale.
//   rmRfProtectedAreas    targets rm -rf may not hit; woven into the rm -rf pattern.
//   embeddedInterpreterEnabled  block `node -e`/`python -c` that does raw file ops. Off
//                         by default: this harness legitimately uses inline interpreters.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.

import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'bash-commands';
const CONFIG_KEY = 'blockDestructiveShellCommands';

// Areas rm -rf must never target. A project overrides this list in config; the rm -rf
// deny pattern is rebuilt from it at runtime (see rmRfSourceFrom), so an edit takes effect.
const DEFAULT_RM_RF_PROTECTED_AREAS = ['/', '*', 'src', 'tests'];

// Process-killing command names, assembled from fragments so the spell checker does not
// read them as prose (the project keeps an empty dictionary by policy).
const KILL_BY_NAME_COMMANDS = ['task' + 'kill', 'p' + 'kill', 'kill' + 'all'];

// PowerShell's kill-by-name form: `Stop-Process -Name node` (and its Get-Process pipe). On
// Windows this reaches every process of that name exactly like taskkill /IM, so it belongs
// in the same block. Matched separately because its shape (a -Name flag) differs from the
// unix commands above.
const STOP_PROCESS_BY_NAME_SOURCE = String.raw`\bStop-Process\b[^|;\n]*\s-Name\b`;

// The rm -rf deny source, built from the protected-areas list. Separate from the static
// deny list so a project can edit rmRfProtectedAreas in config and have it take effect at
// runtime: the list is re-read on every call, not baked in at load time.
function rmRfSourceFrom(protectedAreas) {
  const rmRfTargets = protectedAreas
    .map((area) => area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  // Allow an optional `./` (or `.\`) prefix before the target, so `rm -rf ./src` and
  // `rm -rf .\src` are caught, not just the bare `rm -rf src`. Without this, a leading
  // `./` sat between the required whitespace and the target's word boundary and slipped past.
  return String.raw`\brm\s+-rf\s+(?:\.[\\/])?(${rmRfTargets})\b`;
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
    [
      STOP_PROCESS_BY_NAME_SOURCE,
      'Stop-Process -Name kills every process of that name on the machine, not just yours. ' +
        'Stop the specific process by its Id (the PID you started); if lost, identify it by ' +
        'its full command line and confirm ownership first.',
    ],
  ];
}

// Interpreter name, then any intermediate flags (e.g. --input-type=module), then an
// eval flag. Intermediate flags are matched loosely (`-\S+`) to keep the pattern simple.
const INTERPRETER_EVAL_PATTERN =
  /\b(node|python3?|deno|bun)\b(?:\s+-\S+)*?\s+(?:-e|-c|--eval|--print|-p)\b/i;
const RAW_FILE_OPS_PATTERN =
  /\b(writeFileSync|readFileSync|appendFileSync|fs\.writeFile|fs\.readFile|fs\.unlink|fs\.mkdir)\b/;

function compile(source) {
  return new RegExp(source, 'i');
}

// git's GLOBAL options sit between `git` and the subcommand: `git -C <path> reset --hard`,
// `git -c k=v push`, `git --git-dir=… clean -f`. A pattern that matches `git reset --hard`
// contiguously is evaded by any of them. Stripping these options first — turning
// `git -C /repo reset --hard` back into `git reset --hard` — closes that bypass for every
// git rule at once, instead of teaching each pattern about every global option.
//
// A single global option, matched one at a time and stripped repeatedly (below), so the
// pattern stays simple: an option taking a value (`-C /path`, `--git-dir=…`) or a flag
// (`--no-pager`). The leading `git ` is kept; only the option after it is removed.
const GIT_OPTION_WITH_VALUE = String.raw`(?:-[Cc]|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:\s+|=)\S+`;
const GIT_FLAG_OPTION = String.raw`--(?:paginate|no-pager|bare|no-optional-locks)|-p`;
const GIT_GLOBAL_OPTION_PATTERN = new RegExp(
  String.raw`\bgit\s+(?:${GIT_OPTION_WITH_VALUE}|${GIT_FLAG_OPTION})\s+`,
  'i',
);

function normalizeGitOptions(command) {
  // Strip one leading global option at a time and re-run, so a stacked
  // `git -c a=b -C /x reset` is fully reduced to `git reset` before the deny patterns run.
  let previous;
  let normalized = command;
  do {
    previous = normalized;
    normalized = normalized.replace(GIT_GLOBAL_OPTION_PATTERN, 'git ');
  } while (normalized !== previous);
  return normalized;
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
  if (toolInGroups(toolName, ['shell'])) {
    return String(toolInput.CommandLine ?? toolInput.command ?? '');
  }
  return delegationPromptOf(toolInput);
}

/** Static deny rules + the runtime rm -rf rule, both read from config params. */
function checkDestructive(command, parameters) {
  // Strip git's global options so `git -C /repo reset --hard` cannot slip past a pattern
  // written for `git reset --hard`. Non-git commands are unaffected.
  const normalized = normalizeGitOptions(command);

  // denyPatterns may be a flat list of sources or [source, reason] pairs; normalize.
  const denyPairs = (parameters.denyPatterns ?? []).map((entry) =>
    Array.isArray(entry)
      ? entry
      : [entry, 'Destructive command is not allowed.'],
  );
  for (const [source, reason] of denyPairs) {
    if (compile(source).test(normalized)) deny(CONFIG_KEY, reason);
  }

  // rm -rf over a protected area: areas read from config at runtime, so editing
  // rmRfProtectedAreas takes effect without touching denyPatterns.
  const rmRfAreas =
    parameters.rmRfProtectedAreas ?? DEFAULT_RM_RF_PROTECTED_AREAS;
  if (
    rmRfAreas.length > 0 &&
    compile(rmRfSourceFrom(rmRfAreas)).test(command)
  ) {
    deny(CONFIG_KEY, "'rm -rf' over a protected area is not allowed.");
  }

  if (parameters.embeddedInterpreterEnabled) {
    const reason = checkEmbeddedInterpreter(command);
    if (reason) deny(CONFIG_KEY, reason);
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
    // Destructive-command rules act on a real shell command AND on a delegation prompt (a
    // subagent can be told "run rm -rf" in prose). commandTextFrom picks the right text.
    if (!toolInGroups(toolName, ['shell', 'delegation'])) return;

    const command = commandTextFrom(toolName, toolInput);
    checkDestructive(command, parameters);
  },
);
