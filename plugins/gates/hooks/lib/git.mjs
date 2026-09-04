// git.mjs — the ONE place that understands how a git command line is spelled, so every gate
// that judges a commit, a push or a reset reads the same normalized form. Before this module
// six gates carried byte-identical copies of the option-stripping regex, and every bypass
// (git.exe, a quoted -C path, a missing global option) had to be fixed six times.
//
// ── normalizeGitCommand ─────────────────────────────────────────────────────────────
// Turns any spelling of the git binary (`git`, `git.exe`, `"C:/Program Files/Git/bin/git.exe"`,
// `/usr/bin/git`) into the bare word `git`, then strips git's GLOBAL options (`-C <path>`,
// `-c k=v`, `--git-dir=…`, `--no-pager`, …) that sit between `git` and the subcommand, so a
// pattern written for `git reset --hard` also catches `git -C "C:/My Repo" reset --hard`.
// Quoted option values (a path with a space) are consumed whole.
//
// Self-contained: Node built-ins only.

import { spawnSync } from 'node:child_process';

// The git binary in any spelling: bare, with .exe, or as a (possibly quoted) path ending in
// git/git.exe. Anchored at a command boundary so `digit`/`legit` never match.
const GIT_BINARY_PATTERN = new RegExp(
  String.raw`(^|[\s;&|(])(?:"[^"\n]*[\\/]git(?:\.exe)?"|'[^'\n]*[\\/]git(?:\.exe)?'|(?:[^\s"';&|(]*[\\/])?git(?:\.exe)?)(?=\s)`,
  'gi',
);

// A quoted or bare argument value.
const OPTION_VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\S+)`;
// Global options that take a value, as `-C <v>`, `-C<v>`... no: git requires a space or `=`.
const OPTION_WITH_VALUE = String.raw`(?:-[Cc]|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix|--attr-source|--list-cmds)(?:=|\s+)${OPTION_VALUE}`;
// Global flag options (no value).
const FLAG_OPTION = String.raw`--(?:paginate|no-pager|bare|no-optional-locks|no-replace-objects|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs|no-advice|no-lazy-fetch|html-path|man-path|info-path)|-[pP]`;
const GLOBAL_OPTION_PATTERN = new RegExp(
  String.raw`\bgit\s+(?:${OPTION_WITH_VALUE}|${FLAG_OPTION})\s+`,
  'i',
);

/**
 * The command with every git invocation reduced to `git <subcommand> …`: binary spelling
 * canonicalized and global options removed. Non-git text is untouched.
 */
export function normalizeGitCommand(command) {
  let normalized = String(command ?? '').replace(GIT_BINARY_PATTERN, '$1git');
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replace(GLOBAL_OPTION_PATTERN, 'git ');
  } while (normalized !== previous);
  return normalized;
}

/** Whether the (normalized) command runs `git <subcommand>` anywhere. */
export function isGitSubcommand(command, subcommand) {
  const pattern = new RegExp(String.raw`\bgit\s+${subcommand}(?![\w-])`, 'i');
  return pattern.test(normalizeGitCommand(command));
}

/** A real `git commit` (not `commit-tree`, not `commit-graph`). */
export function isGitCommit(command) {
  return isGitSubcommand(command, 'commit');
}

const DRY_RUN_PATTERN = /\bgit\s+commit\b[^;&|]*--dry-run\b/i;

/** A `git commit --dry-run` writes nothing: commit gates skip it. */
export function isDryRunCommit(command) {
  return DRY_RUN_PATTERN.test(normalizeGitCommand(command));
}

// `--amend` only counts when it is an option OF the commit, not a word later in the line.
const AMEND_PATTERN = /\bgit\s+commit\b[^;&|]*--amend\b/i;

/** A `git commit --amend` reshapes an existing commit; some gates exempt it. */
export function isAmendCommit(command) {
  return AMEND_PATTERN.test(normalizeGitCommand(command));
}

const COMMIT_SEGMENT_PATTERN = /\bgit\s+commit\b([^;&|]*)/i;
const GIT_ADD_PATTERN = /\bgit\s+add\b([^;&|]*)/gi;

/** Whether the commit carries `-a`/`--all` (a short-flag cluster like `-am` counts). */
function commitStagesAll(normalized) {
  const segment = COMMIT_SEGMENT_PATTERN.exec(normalized)?.[1] ?? '';
  return segment.split(/\s+/).some((token) => {
    if (token === '--all') return true;
    return (
      token.startsWith('-') && !token.startsWith('--') && token.includes('a')
    );
  });
}

function splitArguments(text) {
  const found = [];
  for (const match of String(text).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

function runGit(cwd, commandArguments) {
  const result = spawnSync('git', commandArguments, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout;
}

function splitNulTerminated(output) {
  return output
    .split('\0')
    .map((entry) => entry.replace(/\\/g, '/').trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The paths currently staged (`git diff --cached`), read NUL-terminated so a non-ASCII or
 * space-containing name comes back verbatim instead of quoted/escaped. `filter` is git's
 * `--diff-filter` letters (default ACMR: added/copied/modified/renamed). Null when git could
 * not be queried (not a repo, git missing).
 */
export function stagedFiles(cwd, { filter = 'ACMR' } = {}) {
  const output = runGit(cwd, [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    `--diff-filter=${filter}`,
  ]);
  return output === null ? null : splitNulTerminated(output);
}

// Porcelain v1 -z entries: `XY path` (rename: `XY new\0old`). Status letters per column.
const PORCELAIN_STATUS_WIDTH = 2;
const PORCELAIN_PATH_OFFSET = 3;

function parsePorcelain(output) {
  const entries = [];
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, PORCELAIN_STATUS_WIDTH);
    const path = field.slice(PORCELAIN_PATH_OFFSET).replace(/\\/g, '/');
    entries.push({ status, path });
    if (status[0] === 'R' || status[0] === 'C') index += 1; // skip the old path
  }
  return entries;
}

/** Working-tree changes (`git status --porcelain -z`): [{ status, path }], or null. */
export function workingTreeChanges(cwd) {
  const output = runGit(cwd, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '-z',
  ]);
  return output === null ? null : parsePorcelain(output);
}

function isUntrackedOrModified(entry) {
  return entry.status === '??' || entry.status[1] !== ' ';
}

function isTrackedModified(entry) {
  return entry.status !== '??' && entry.status[1] !== ' ';
}

/**
 * The files a commit command WILL have staged by the time it runs — which a PreToolUse hook
 * cannot read from the index, because the hook runs before `git add -A && git commit` or
 * `git commit -a` executes. The answer is the union of what is staged now, what a `git add`
 * earlier in the same command line stages, and every modified tracked file when the commit
 * carries `-a`. Explicit `git add <paths>` contribute those paths (a directory contributes
 * everything under it). Null when git cannot be queried.
 */
export function effectiveCommitFiles(cwd, command) {
  const staged = stagedFiles(cwd);
  if (staged === null) return null;
  const normalized = normalizeGitCommand(command);
  const files = new Set(staged);

  const stagesAll = commitStagesAll(normalized);
  const needsWorkingTree = stagesAll || /\bgit\s+add\b/i.test(normalized);
  if (!needsWorkingTree) return [...files];

  const changes = workingTreeChanges(cwd) ?? [];
  if (stagesAll) {
    for (const entry of changes.filter(isTrackedModified))
      files.add(entry.path);
  }
  for (const match of normalized.matchAll(GIT_ADD_PATTERN)) {
    const addArguments = splitArguments(match[1]).filter(
      (argument) => !argument.startsWith('-'),
    );
    const stagesEverything =
      /\s(?:-A|--all|-a|-u|--update)\b/.test(match[1]) ||
      addArguments.includes('.');
    for (const entry of changes.filter(isUntrackedOrModified)) {
      const covered =
        stagesEverything ||
        addArguments.some(
          (argument) =>
            entry.path === argument ||
            entry.path.startsWith(`${argument.replace(/\/$/, '')}/`),
        );
      if (covered) files.add(entry.path);
    }
  }
  return [...files];
}

// Message sources inside a commit command: -m "…", -m '…', --message=…, a heredoc body,
// --trailer key=value, and -F/--file <path> (read from disk when it exists under cwd).
const MESSAGE_FLAG_PATTERN =
  /(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
// The opener of a heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`. The body is then located
// by plain string search (the closing marker on its own line), not by a backtracking regex.
const HEREDOC_OPENER_PATTERN = /<<-?\s*['"]?(\w+)['"]?/g;

/** The bodies of every heredoc in the command, in order. */
function heredocBodiesOf(text) {
  const bodies = [];
  for (const match of text.matchAll(HEREDOC_OPENER_PATTERN)) {
    const marker = match[1];
    const bodyStart = text.indexOf('\n', match.index + match[0].length);
    if (bodyStart === -1) continue;
    const lines = text.slice(bodyStart + 1).split('\n');
    const end = lines.findIndex((line) => line.trim() === marker);
    bodies.push((end === -1 ? lines : lines.slice(0, end)).join('\n'));
  }
  return bodies;
}
const TRAILER_PATTERN =
  /(?:^|\s)--trailer(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
const MESSAGE_FILE_PATTERN =
  /(?:^|\s)(?:-F|--file)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g;

/**
 * Every piece of commit-message text the command carries, joined by newlines: inline -m
 * values, heredoc bodies, --trailer values, and the contents of a -F file (via
 * `readFile(path)`, injected so the caller decides how to read — default returns '').
 * Returns '' for a command with no recognizable message source.
 */
function firstGroup(match) {
  return match[1] ?? match[2] ?? match[3] ?? '';
}

function messagePiecesOf(text, pattern, pick = firstGroup) {
  return [...text.matchAll(pattern)].map(pick);
}

export function commitMessageOf(command, { readFile = () => '' } = {}) {
  const text = String(command ?? '');
  const pieces = [
    ...messagePiecesOf(text, MESSAGE_FLAG_PATTERN),
    ...heredocBodiesOf(text),
    ...messagePiecesOf(text, TRAILER_PATTERN),
    ...messagePiecesOf(text, MESSAGE_FILE_PATTERN, (match) =>
      String(readFile(firstGroup(match)) ?? ''),
    ),
  ];
  return pieces.filter((piece) => piece.length > 0).join('\n');
}
