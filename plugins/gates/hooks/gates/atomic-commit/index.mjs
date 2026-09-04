// atomic-commit — denies a `git commit` that is not atomic: one mixing more distinct NATURES
// of change (code + tests + deps + config) than `maxNatures`, or carrying more reviewable
// files than `maxFiles`. It judges what the commit WILL contain (the staged set, plus what a
// `git add …` in the same command line or `-a` stages, plus staged deletions); docs, assets
// and generated files count toward neither. An `--amend` reshapes an existing commit and is
// left alone, as is a `--dry-run`. Only a command segment that RUNS git commit counts. git
// not queryable: allow — the gate cannot judge and must not block on a git error.

import { projectRootOf } from '../../lib/config.mjs';
import {
  effectiveCommitFiles,
  isAmendCommit,
  isDryRunCommit,
  isGitCommit,
  normalizeGitCommand,
  stagedFiles,
} from '../../lib/git.mjs';
import {
  compileRegex,
  deny,
  runGate,
  shellCommandOf,
  toolInGroups,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'atomic-commit';
const CONFIG_KEY = 'blockNonAtomicCommits';

const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_NATURES = 2;
const DEFAULT_ESCAPE_HATCH = '[wip]';

// First match wins. `counts:false` = committed alongside anything, never reviewed line by
// line. A `hooks/` or `models/` folder is application code (React hooks, MVC models), not
// tooling or types: types are `*.d.ts` and `types/` folders only.
const DEFAULT_NATURES = [
  {
    name: 'deps',
    source: String.raw`(^|/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|Cargo\.lock|go\.sum)$`,
    counts: true,
  },
  {
    name: 'generated',
    source: String.raw`(^|/)(dist|build|coverage|__snapshots__)/|\.snap$|baseline.*\.json$`,
    counts: false,
  },
  {
    name: 'assets',
    source: String.raw`\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp[34]|wav|webm|pdf)$`,
    counts: false,
  },
  {
    name: 'docs',
    source: String.raw`\.(md|mdx|txt|adoc|rst|org|log|csv|tsv)$`,
    counts: false,
  },
  {
    name: 'config',
    source: String.raw`(^|/)(tsconfig.*\.json|.*\.config\.[cm]?[jt]s|\.eslintrc.*|\.prettierrc.*|\.editorconfig|Dockerfile|docker-compose\.ya?ml|\.gitattributes|\.gitignore)$`,
    counts: true,
  },
  {
    name: 'types',
    source: String.raw`(^|/)types?/|\.d\.ts$`,
    counts: true,
  },
  {
    name: 'tests',
    source: String.raw`(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[cm]?[jt]sx?$`,
    counts: true,
  },
  {
    name: 'tooling',
    source: String.raw`(^|/)(scripts|\.ai|\.claude|\.github)/`,
    counts: true,
  },
];
const DEFAULT_NATURE = { name: 'code', counts: true };

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

function runsJudgedCommit(command) {
  return String(command)
    .split(SEGMENT_SEPARATOR)
    .some((segment) => {
      if (!runsGit(segment)) return false;
      const normalized = normalizeGitCommand(segment);
      return (
        isGitCommit(normalized) &&
        !isDryRunCommit(normalized) &&
        !isAmendCommit(normalized)
      );
    });
}

// ── Natures ─────────────────────────────────────────────────────────────────────────
function compileNatures(natures) {
  const compiled = [];
  for (const nature of natures) {
    if (!nature || typeof nature !== 'object') continue;
    if (typeof nature.name !== 'string' || typeof nature.source !== 'string')
      continue;
    const pattern = compileRegex(nature.source);
    if (!pattern) continue;
    compiled.push({
      name: nature.name,
      counts: nature.counts !== false,
      pattern,
    });
  }
  return compiled;
}

function natureOf(filePath, compiledNatures) {
  return (
    compiledNatures.find((nature) => nature.pattern.test(filePath)) ??
    DEFAULT_NATURE
  );
}

function classify(files, compiledNatures) {
  const counted = [];
  const countedNatures = new Set();
  for (const file of files) {
    const nature = natureOf(file, compiledNatures);
    if (!nature.counts) continue;
    counted.push(file);
    countedNatures.add(nature.name);
  }
  return { counted, countedNatures };
}

function commitFiles(root, command) {
  const files = effectiveCommitFiles(root, command);
  if (files === null) return null;
  const deletions = stagedFiles(root, { filter: 'D' }) ?? [];
  return [...new Set([...files, ...deletions])];
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      maxFiles: DEFAULT_MAX_FILES,
      maxNatures: DEFAULT_MAX_NATURES,
      escapeHatch: DEFAULT_ESCAPE_HATCH,
      natures: DEFAULT_NATURES,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['shell'])) return;

    const command = shellCommandOf(toolInput);
    if (!runsJudgedCommit(command)) return;

    const escapeHatch = String(parameters.escapeHatch ?? '');
    if (escapeHatch && command.includes(escapeHatch)) return;

    const files = commitFiles(projectRootOf(cwd) ?? cwd, command);
    if (!files || files.length === 0) return;

    const { counted, countedNatures } = classify(
      files,
      compileNatures(parameters.natures),
    );
    const { maxFiles, maxNatures } = parameters;

    if (countedNatures.size > maxNatures) {
      deny(
        CONFIG_KEY,
        `This commit mixes ${countedNatures.size} kinds of change ` +
          `(${[...countedNatures].join(', ')}) — a commit should be one cohesive change ` +
          `(max ${maxNatures}). Split it: stage and commit one nature at a time (e.g. the ` +
          `code, then its tests, then deps). Docs/assets/generated files do not count. ` +
          `Add "${escapeHatch}" to the command for one deliberately broad commit.`,
      );
    }

    if (counted.length > maxFiles) {
      deny(
        CONFIG_KEY,
        `This commit carries ${counted.length} reviewable files (max ${maxFiles}) — too large ` +
          `to review as one unit. Split it into smaller, cohesive commits (docs/assets/` +
          `generated files are not counted). Add "${escapeHatch}" for one deliberately broad commit.`,
      );
    }
  },
);
