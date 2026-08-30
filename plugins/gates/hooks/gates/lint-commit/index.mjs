// lint-commit — denies `git commit` while the project's lint script fails. The gate never
// invents a lint step: it only runs a `lint` script the project itself declared in
// package.json (or an explicit override), so a project with no linter configured is left
// alone (allow, silent).
//
// justification: no existing tool covers this. bash-commands (the other shell gate) only
// pattern-matches the command text; it never SPAWNS a check. This is the first gate that
// runs an external process as its verdict.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   lintCommand     explicit command to run instead of autodetecting `npm run lint`.
//                   null (default) means: read package.json's `scripts.lint`, and if
//                   absent, allow — this gate does not invent a lint step.
//   lintTimeoutMs   how long the lint run may take before it is treated as a failure.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.
//
// ── How it detects a commit ──────────────────────────────────────────────────────────
// Reuses bash-commands' git-global-option normalization idea: `git -C <path> commit` or
// `git -c user.name=x commit` must be caught the same as a bare `git commit`. Only a real
// commit (not `git commit --help`, not a mention inside a delegation prompt describing one)
// is gated — this runs on the shell tool only, not on delegation text, because spawning a
// lint run for a prompt that merely MENTIONS a commit would be wasted work and a false
// blocker on unrelated delegations.
//
// ── Why spawnSync + shell:true on Windows ────────────────────────────────────────────
// `npm` is `npm.cmd` on Windows; resolving the concrete binary name per platform is more
// fragile than letting the shell resolve it, so this always spawns through the shell.
//
// ── Fail-safe shape ───────────────────────────────────────────────────────────────────
// No package.json, or package.json with no `scripts.lint` and no `lintCommand` override:
// allow (nothing to enforce, never invented). Lint run exits non-zero: deny with the last
// ~15 lines of its combined output. Lint run exits zero: allow.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runGate, deny, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'lint-commit';
const CONFIG_KEY = 'blockCommitWithFailingLint';

const SHELL_GROUPS = ['shell'];
const DEFAULT_LINT_TIMEOUT_MS = 60000;
const OUTPUT_TAIL_LINES = 15;

// One global git option at a time, stripped repeatedly — same normalization bash-commands
// uses so `git -C /repo -c x=y commit` reduces to `git commit` before the pattern runs.
const GIT_OPTION_WITH_VALUE = String.raw`(?:-[Cc]|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:\s+|=)\S+`;
const GIT_FLAG_OPTION = String.raw`--(?:paginate|no-pager|bare|no-optional-locks)|-p`;
const GIT_GLOBAL_OPTION_PATTERN = new RegExp(
  String.raw`\bgit\s+(?:${GIT_OPTION_WITH_VALUE}|${GIT_FLAG_OPTION})\s+`,
  'i',
);
const GIT_COMMIT_PATTERN = /\bgit\s+commit\b/i;

function normalizeGitOptions(command) {
  let previous;
  let normalized = command;
  do {
    previous = normalized;
    normalized = normalized.replace(GIT_GLOBAL_OPTION_PATTERN, 'git ');
  } while (normalized !== previous);
  return normalized;
}

function isGitCommit(command) {
  return GIT_COMMIT_PATTERN.test(normalizeGitOptions(command));
}

function commandTextFrom(toolInput) {
  return String(toolInput.CommandLine ?? toolInput.command ?? '');
}

/** The project's declared lint command, or null when none is declared (never invented). */
function resolveLintCommand(cwd, lintCommandOverride) {
  if (lintCommandOverride) return lintCommandOverride;

  const packageJsonPath = join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (packageJson?.scripts?.lint) return 'npm run lint';
    return null;
  } catch {
    // Corrupt package.json is not this gate's problem to diagnose; do not invent a lint step.
    return null;
  }
}

function tailLines(text, count) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-count).join('\n');
}

function runLint(lintCommand, cwd, timeoutMs) {
  return spawnSync(lintCommand, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      lintCommand: null,
      lintTimeoutMs: DEFAULT_LINT_TIMEOUT_MS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, SHELL_GROUPS)) return;

    const command = commandTextFrom(toolInput);
    if (!isGitCommit(command)) return;

    const cwd = process.cwd();
    const lintCommand = resolveLintCommand(cwd, parameters.lintCommand);
    if (!lintCommand) return; // no lint script declared anywhere: nothing to enforce

    const timeoutMs = parameters.lintTimeoutMs ?? DEFAULT_LINT_TIMEOUT_MS;
    const result = runLint(lintCommand, cwd, timeoutMs);

    if (result.error) {
      // The lint process itself could not be spawned (bad shell, missing interpreter, or a
      // timeout kill). A commit gate that cannot evaluate must not silently permit — deny
      // with the spawn error so the user can fix the environment, not guess.
      deny(
        GATE_ID,
        `Could not run the lint command ("${lintCommand}"): ${result.error.message}. Fix ` +
          'the lint setup or set lintCommand/blockCommitWithFailingLint in .ai/config.json.',
      );
    }

    if (result.status !== 0) {
      const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
      deny(
        GATE_ID,
        `Lint failed (exit ${result.status}) — commit blocked until it passes:\n` +
          `${tailLines(combinedOutput, OUTPUT_TAIL_LINES)}`,
      );
    }
  },
);
