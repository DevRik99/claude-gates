// staged-lint — denies a `git commit` when the files THIS commit carries fail lint. It never
// lints the whole repo (pre-existing debt in untouched files must not block you); it lints
// what the commit will contain: the staged set plus whatever a `git add …` earlier in the
// same command line or a `-a` flag stages before the commit runs. Only a command segment that
// RUNS git commit counts; a `--dry-run` writes nothing. No lintable file, or no linter
// declared or detected: allow — this gate never invents a linter. A lint run that cannot
// spawn is denied: a commit gate must not silently permit.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import {
  effectiveCommitFiles,
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

const GATE_ID = 'staged-lint';
const CONFIG_KEY = 'blockCommitWithStagedLintErrors';

const DEFAULT_LINT_TIMEOUT_MS = 60000;
const OUTPUT_TAIL_LINES = 20;
const DEFAULT_ESCAPE_HATCH = '[skip-lint]';
const DEFAULT_LINT_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
];
const ESLINT_CONFIG_FILES = [
  'eslint.config.mjs',
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

// ── The commit segment ──────────────────────────────────────────────────────────────
const SEGMENT_SEPARATOR = /;|&&|\|\||\||\n/;
const ARGUMENT_PATTERN = /"([^"]*)"|'([^']*)'|(\S+)/g;
const GIT_BINARY_TOKEN = /(?:^|[\\/])git(?:\.exe)?$/i;
const WRAPPER_TOKEN = /^(?:\w+=\S*|command|sudo|env)$/i;

function runsGit(segment) {
  const tokens = [];
  for (const match of segment.matchAll(ARGUMENT_PATTERN))
    tokens.push(match[1] ?? match[2] ?? match[3]);
  while (tokens.length > 0 && WRAPPER_TOKEN.test(tokens[0])) tokens.shift();
  return tokens.length > 0 && GIT_BINARY_TOKEN.test(tokens[0]);
}

function runsRealCommit(command) {
  return String(command)
    .split(SEGMENT_SEPARATOR)
    .some((segment) => {
      if (!runsGit(segment)) return false;
      const normalized = normalizeGitCommand(segment);
      return isGitCommit(normalized) && !isDryRunCommit(normalized);
    });
}

// ── Lint ────────────────────────────────────────────────────────────────────────────
function normalizeExtension(extension) {
  const text = String(extension).trim().toLowerCase();
  return text.startsWith('.') ? text : `.${text}`;
}

function resolveLintCommand(root, lintCommandOverride) {
  if (typeof lintCommandOverride === 'string' && lintCommandOverride.trim())
    return lintCommandOverride;
  const hasEslintFile = ESLINT_CONFIG_FILES.some((name) =>
    existsSync(join(root, name)),
  );
  const packageJson = readJsonOrNull(join(root, 'package.json'));
  return hasEslintFile || packageJson?.eslintConfig ? 'npx eslint' : null;
}

function tailLines(text, count) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-count)
    .join('\n');
}

function runLintOverFiles(lintCommand, files, cwd, timeoutMs) {
  const quotedPaths = files.map((file) => `"${file}"`).join(' ');
  return spawnSync(`${lintCommand} ${quotedPaths}`, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function denyIfLintFailed(result, lintCommand, escapeHatch) {
  if (result.error) {
    deny(
      CONFIG_KEY,
      `Could not run the lint command ("${lintCommand}") over the commit's files: ` +
        `${result.error.message}. Fix the lint setup or set lintCommand under ` +
        `${CONFIG_KEY} in .ai/config.json.`,
    );
  }
  if (result.status !== 0) {
    const combinedOutput =
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    deny(
      CONFIG_KEY,
      `The files this commit carries fail lint — commit blocked until your own changes are ` +
        `clean (the rest of the repo is not checked). Fix them, or add "${escapeHatch}" to ` +
        `the commit command for a deliberate exception:\n${tailLines(combinedOutput, OUTPUT_TAIL_LINES)}`,
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
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['shell'])) return;

    const command = shellCommandOf(toolInput);
    if (!runsRealCommit(command)) return;

    const escapeHatch = String(parameters.escapeHatch ?? '');
    if (escapeHatch && command.includes(escapeHatch)) return;

    const root = projectRootOf(cwd) ?? cwd;
    const extensions = new Set(
      parameters.lintExtensions.map(normalizeExtension),
    );
    const files = (effectiveCommitFiles(root, command) ?? []).filter((file) =>
      extensions.has(extname(file).toLowerCase()),
    );
    if (files.length === 0) return;

    const lintCommand = resolveLintCommand(root, parameters.lintCommand);
    if (!lintCommand) return;

    const result = runLintOverFiles(
      lintCommand,
      files,
      root,
      parameters.lintTimeoutMs,
    );
    denyIfLintFailed(result, lintCommand, escapeHatch);
  },
);
