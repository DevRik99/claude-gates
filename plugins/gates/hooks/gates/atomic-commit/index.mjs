// atomic-commit — denies a `git commit` that is not atomic: one that mixes too many distinct
// NATURES of change (code + tests + deps + config in one shot) or stages more reviewable files
// than a commit should carry. It never commits or groups for you (that is a tool, not a gate,
// and the user already has guard-autocommit for it); it only OBJECTS when the staged set is not
// a cohesive, reviewable unit, so the split happens before the commit lands.
//
// justification: no existing gate covers this. lint-commit/staged-lint run the linter on a
// commit; no-coauthor reads the message; none look at the SHAPE of the staged set. This is the
// first gate that judges whether a commit is atomic.
//
// ── How it decides (deterministic) ───────────────────────────────────────────────────
// On a real `git commit`, it lists the staged files and classifies each by nature (deps,
// generated, assets, docs, config, types, tests, tooling, or code). Docs/assets/generated do
// NOT count toward the size or the mix — they are legitimately committed alongside anything and
// are not reviewed line by line (same rule guard-autocommit uses). Among the files that DO
// count, it blocks when either:
//   · the number of distinct counted natures exceeds `maxNatures` (default 2 — e.g. code+tests
//     is fine, but code+tests+deps+config in one commit is not atomic), or
//   · the number of counted files exceeds `maxFiles` (default 12) — too large to review.
// A commit that is already scoped (`--amend`, a merge, or the escape hatch) is left alone.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   maxFiles     max counted files in one commit. Default 12.
//   maxNatures   max distinct counted natures in one commit. Default 2.
//   escapeHatch  substring in the command that allows one deliberately broad commit.
//                Default '[wip]'.
//   natures      the classification table (name + regex source + counts flag). Replaces the
//                built-in list wholesale.
//
// ── Fail-safe shape ──────────────────────────────────────────────────────────────────
// Not a commit, an --amend, or nothing staged: allow (silent). git not queryable: allow (the
// gate cannot judge and must not block a legitimate commit on a git error). Otherwise: deny
// with the offending mix/size and how to split.

import { spawnSync } from 'node:child_process';
import { runGate, deny, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'atomic-commit';
const CONFIG_KEY = 'blockNonAtomicCommits';

const SHELL_GROUPS = ['shell'];
const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_NATURES = 2;
const DEFAULT_ESCAPE_HATCH = '[wip]';

// Nature table, evaluated in order (first match wins), mirroring guard-autocommit's catalog so
// a project that uses both sees the same grouping. `counts:false` = committed alongside anything
// and not counted toward size/mix (docs, assets, generated artifacts).
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
    source: String.raw`(^|/)(types?|interfaces?|models?|schemas?)/|\.d\.ts$`,
    counts: true,
  },
  {
    name: 'tests',
    source: String.raw`(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[cm]?[jt]sx?$`,
    counts: true,
  },
  {
    name: 'tooling',
    source: String.raw`(^|/)(scripts|hooks|\.ai|\.claude|\.github)/`,
    counts: true,
  },
];
const DEFAULT_NATURE = { name: 'code', counts: true };

// git-global-option normalization, shared with the other commit gates.
const GIT_OPTION_WITH_VALUE = String.raw`(?:-[Cc]|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:\s+|=)\S+`;
const GIT_FLAG_OPTION = String.raw`--(?:paginate|no-pager|bare|no-optional-locks)|-p`;
const GIT_GLOBAL_OPTION_PATTERN = new RegExp(
  String.raw`\bgit\s+(?:${GIT_OPTION_WITH_VALUE}|${GIT_FLAG_OPTION})\s+`,
  'i',
);
const GIT_COMMIT_PATTERN = /\bgit\s+commit\b/i;
// An --amend or a merge commit is a deliberate, already-scoped operation — not this gate's.
const EXEMPT_COMMIT_PATTERN = /--amend\b|\bgit\s+merge\b/i;

function normalizeGitOptions(command) {
  let previous;
  let normalized = command;
  do {
    previous = normalized;
    normalized = normalized.replace(GIT_GLOBAL_OPTION_PATTERN, 'git ');
  } while (normalized !== previous);
  return normalized;
}

function isPlainCommit(command) {
  const normalized = normalizeGitOptions(command);
  return (
    GIT_COMMIT_PATTERN.test(normalized) &&
    !EXEMPT_COMMIT_PATTERN.test(normalized)
  );
}

function commandTextFrom(toolInput) {
  return String(toolInput.CommandLine ?? toolInput.command ?? '');
}

/** The staged files (added/copied/modified/renamed), or [] when git cannot be queried. */
function stagedFiles(cwd) {
  const result = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\\/g, '/'));
}

function compileNatures(natures) {
  return natures.map((nature) => ({
    name: nature.name,
    counts: nature.counts !== false,
    pattern: (() => {
      try {
        return new RegExp(nature.source, 'i');
      } catch {
        return null;
      }
    })(),
  }));
}

function natureOf(filePath, compiledNatures) {
  for (const nature of compiledNatures) {
    if (nature.pattern && nature.pattern.test(filePath)) return nature;
  }
  return DEFAULT_NATURE;
}

/** Classifies the staged files: the counted (reviewable) ones and the distinct natures among
 * them. Docs/assets/generated (counts:false) are excluded from both. */
function classifyStaged(files, compiledNatures) {
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
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, SHELL_GROUPS)) return;

    const command = commandTextFrom(toolInput);
    if (!isPlainCommit(command)) return;

    const escapeHatch = parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH;
    if (escapeHatch && command.includes(escapeHatch)) return;

    const cwd = process.cwd();
    const files = stagedFiles(cwd);
    if (files.length === 0) return; // nothing staged (or git unqueryable): nothing to judge

    const compiledNatures = compileNatures(
      parameters.natures ?? DEFAULT_NATURES,
    );
    const { counted, countedNatures } = classifyStaged(files, compiledNatures);

    const maxFiles = parameters.maxFiles ?? DEFAULT_MAX_FILES;
    const maxNatures = parameters.maxNatures ?? DEFAULT_MAX_NATURES;

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
        `This commit stages ${counted.length} reviewable files (max ${maxFiles}) — too large ` +
          `to review as one unit. Split it into smaller, cohesive commits (docs/assets/` +
          `generated files are not counted). Add "${escapeHatch}" for one deliberately broad commit.`,
      );
    }
  },
);
