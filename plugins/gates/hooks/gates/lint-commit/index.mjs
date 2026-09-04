// lint-commit — denies a `git commit` while the project's lint script fails. It never invents
// a lint step: only a `lint` script the project declared in package.json (or an explicit
// lintCommand) runs, and only for a command segment that RUNS git commit (a `grep "git
// commit"` is not one; a `--dry-run` writes nothing). The lint runs in the repo the commit
// targets: `-C <path>` when given, else the project root of the cwd. Spawned through the
// shell because `npm` is `npm.cmd` on Windows. A commit that cannot be evaluated (the lint
// process fails to spawn) is denied: a commit gate must not silently permit.

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import {
  isDryRunCommit,
  isGitCommit,
  normalizeGitCommand,
} from '../../lib/git.mjs';
import {
  deny,
  runGate,
  shellCommandOf,
  toolInGroups,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'lint-commit';
const CONFIG_KEY = 'blockCommitWithFailingLint';

const DEFAULT_LINT_TIMEOUT_MS = 60000;
const OUTPUT_TAIL_LINES = 15;

// ── The commit segment ──────────────────────────────────────────────────────────────
const SEGMENT_SEPARATOR = /;|&&|\|\||\||\n/;
const ARGUMENT_PATTERN = /"([^"]*)"|'([^']*)'|(\S+)/g;
const GIT_BINARY_TOKEN = /(?:^|[\\/])git(?:\.exe)?$/i;
const WRAPPER_TOKEN = /^(?:\w+=\S*|command|sudo|env)$/i;

function tokensOf(text) {
  const tokens = [];
  for (const match of text.matchAll(ARGUMENT_PATTERN))
    tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function runsGit(segment) {
  const tokens = tokensOf(segment);
  while (tokens.length > 0 && WRAPPER_TOKEN.test(tokens[0])) tokens.shift();
  return tokens.length > 0 && GIT_BINARY_TOKEN.test(tokens[0]);
}

function commitSegmentOf(command) {
  for (const segment of String(command).split(SEGMENT_SEPARATOR)) {
    if (!runsGit(segment)) continue;
    const normalized = normalizeGitCommand(segment);
    if (isGitCommit(normalized) && !isDryRunCommit(normalized)) return segment;
  }
  return null;
}

// `-C` BEFORE the subcommand is git's working directory; after `commit` it reuses a message.
function commitDirectoryOf(segment) {
  const tokens = tokensOf(segment);
  const gitIndex = tokens.findIndex((token) => GIT_BINARY_TOKEN.test(token));
  for (let index = gitIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index] === 'commit') return null;
    if (tokens[index] === '-C') return tokens[index + 1] ?? null;
  }
  return null;
}

// ── Lint ────────────────────────────────────────────────────────────────────────────
function resolveLintCommand(lintDirectory, lintCommandOverride) {
  if (typeof lintCommandOverride === 'string' && lintCommandOverride.trim())
    return lintCommandOverride;
  const packageJson = readJsonOrNull(join(lintDirectory, 'package.json'));
  return packageJson?.scripts?.lint ? 'npm run lint' : null;
}

function tailLines(text, count) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-count)
    .join('\n');
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
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['shell'])) return;

    const segment = commitSegmentOf(shellCommandOf(toolInput));
    if (segment === null) return;

    const explicitDirectory = commitDirectoryOf(segment);
    const lintDirectory = explicitDirectory
      ? resolve(cwd, explicitDirectory)
      : (projectRootOf(cwd) ?? cwd);
    const lintCommand = resolveLintCommand(
      lintDirectory,
      parameters.lintCommand,
    );
    if (!lintCommand) return;

    const result = runLint(
      lintCommand,
      lintDirectory,
      parameters.lintTimeoutMs,
    );
    if (result.error) {
      deny(
        CONFIG_KEY,
        `Could not run the lint command ("${lintCommand}" in ${lintDirectory}): ` +
          `${result.error.message}. Fix the lint setup, or set lintCommand under ` +
          `${CONFIG_KEY} in .ai/config.json.`,
      );
    }
    if (result.status !== 0) {
      const combinedOutput =
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
      deny(
        CONFIG_KEY,
        `Lint failed (exit ${result.status}, "${lintCommand}" in ${lintDirectory}) — ` +
          `commit blocked until it passes:\n${tailLines(combinedOutput, OUTPUT_TAIL_LINES)}`,
      );
    }
  },
);
