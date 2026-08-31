// staged-lint — denies a `git commit` when the files YOU staged fail lint. It never lints the
// whole repo (that would block you on pre-existing debt in files you never touched); it lints
// ONLY the staged files — what this commit actually introduces — so a clean commit is never
// held hostage by someone else's old lint errors, and you can never add NEW lint debt through
// your own change.
//
// justification: no existing gate covers this. lint-commit runs the project's lint script over
// the WHOLE project and blocks if anything fails — too broad: a repo with pre-existing debt can
// never commit. This gate scopes the check to the staged set, so it enforces "your change is
// clean" without demanding "the whole repo is clean".
//
// ── How it works ─────────────────────────────────────────────────────────────────────
// On a real `git commit`, it asks git for the staged files (`git diff --cached --name-only
// --diff-filter=ACM`), keeps the ones with a lintable extension, and runs the project's lint
// command over exactly those paths. Non-zero exit → deny with the lint output. No staged
// lintable file, or no lint command declared → allow (nothing to enforce, never invented).
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   lintCommand      the command to run; the staged paths are appended as arguments. Default
//                    null → autodetect eslint (`npx eslint`) when the project has an eslint
//                    config, else allow (never invent a linter).
//   lintExtensions   which staged file extensions are linted. Default js/mjs/cjs/ts/tsx/jsx.
//   lintTimeoutMs    how long the lint run may take before it counts as a failure.
//   escapeHatch      substring in the command that skips the check for one commit. Default
//                    '[skip-lint]'.
//
// ── Fail-safe shape ──────────────────────────────────────────────────────────────────
// Not a commit: allow (silent). No staged lintable files, or no linter: allow. The lint run
// cannot spawn: deny (a commit gate that cannot evaluate must not silently permit). Lint exits
// non-zero: deny with the tail of its output. Lint exits zero: allow.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { runGate, deny, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'staged-lint';
const CONFIG_KEY = 'blockCommitWithStagedLintErrors';

const SHELL_GROUPS = ['shell'];
const DEFAULT_LINT_TIMEOUT_MS = 60000;
const OUTPUT_TAIL_LINES = 20;
const DEFAULT_ESCAPE_HATCH = '[skip-lint]';
const DEFAULT_LINT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
const ESLINT_CONFIG_FILES = [
  'eslint.config.mjs',
  'eslint.config.js',
  'eslint.config.cjs',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

// Same git-global-option normalization lint-commit and no-coauthor use, so
// `git -C /repo -c x=y commit` reduces to `git commit` before the pattern runs.
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

/** The staged files added/copied/modified (not deleted), with an extension in scope. */
function stagedFilesToLint(cwd, lintExtensions) {
  const result = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((file) => lintExtensions.includes(extname(file).toLowerCase()));
}

/** The lint command to run, or null when none can be determined (never invented). */
function resolveLintCommand(cwd, lintCommandOverride) {
  if (lintCommandOverride) return lintCommandOverride;
  const hasEslint = ESLINT_CONFIG_FILES.some((name) =>
    existsSync(join(cwd, name)),
  );
  return hasEslint ? 'npx eslint' : null;
}

function tailLines(text, count) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  return lines.slice(-count).join('\n');
}

/** The lint command with the staged paths appended (quoted), so ONLY they are linted. */
function lintCommandForFiles(lintCommand, files) {
  const quotedPaths = files.map((file) => `"${file}"`).join(' ');
  return `${lintCommand} ${quotedPaths}`;
}

/** Runs the lint command over the staged files; returns the spawnSync result. */
function runLintOverStaged(lintCommand, files, cwd, timeoutMs) {
  return spawnSync(lintCommandForFiles(lintCommand, files), {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

/** Denies when the lint run could not spawn or reported failures; otherwise returns. */
function denyIfLintFailed(result, lintCommand, escapeHatch) {
  if (result.error) {
    deny(
      GATE_ID,
      `Could not run the lint command ("${lintCommand}") over the staged files: ` +
        `${result.error.message}. Fix the lint setup or set lintCommand/` +
        `${CONFIG_KEY} in .ai/config.json.`,
    );
  }
  if (result.status !== 0) {
    const combinedOutput =
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const outputTail = tailLines(combinedOutput, OUTPUT_TAIL_LINES);
    deny(
      GATE_ID,
      `The files you staged fail lint — commit blocked until your own changes are clean ` +
        `(the rest of the repo is not checked). Fix them, or add "${escapeHatch}" to the ` +
        `commit command for a deliberate exception:\n${outputTail}`,
    );
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      lintCommand: null,
      lintExtensions: DEFAULT_LINT_EXTENSIONS,
      lintTimeoutMs: DEFAULT_LINT_TIMEOUT_MS,
      escapeHatch: DEFAULT_ESCAPE_HATCH,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, SHELL_GROUPS)) return;

    const command = commandTextFrom(toolInput);
    if (!isGitCommit(command)) return;

    const escapeHatch = parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH;
    if (escapeHatch && command.includes(escapeHatch)) return;

    const cwd = process.cwd();
    const stagedFiles = stagedFilesToLint(cwd, parameters.lintExtensions);
    if (stagedFiles.length === 0) return; // nothing you staged is in scope: nothing to enforce

    const lintCommand = resolveLintCommand(cwd, parameters.lintCommand);
    if (!lintCommand) return; // no linter declared/detected: never invent one

    const timeoutMs = parameters.lintTimeoutMs ?? DEFAULT_LINT_TIMEOUT_MS;
    const result = runLintOverStaged(lintCommand, stagedFiles, cwd, timeoutMs);
    denyIfLintFailed(result, lintCommand, escapeHatch);
  },
);
