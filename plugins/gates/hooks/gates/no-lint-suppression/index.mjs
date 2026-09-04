// no-lint-suppression — denies a write that SILENCES a linter/type-checker instead of fixing
// the code: a NEW inline disable directive in a source file, or a rule turned off/downgraded
// in a watched config file. A line already present in the file on disk is not a new
// suppression (rewriting a file must not re-litigate old ones). A legitimate suppression is
// allowed by putting the escape hatch on the SAME line, so the reason lives next to it in the
// diff. Deliberate limits: `@ts-expect-error` WITH a description is the recommended form and
// passes; in config files only a rule-like key (`a/b`, `no-x`, or one under a rules/overrides
// block) counts, so `"printWidth": 0` is not a weakening; shell writes are out of scope.

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  compileRegexList,
  deny,
  escapeRegExp,
  runGate,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'no-lint-suppression';
const CONFIG_KEY = 'blockLintSuppression';

const DEFAULT_SUPPRESSION_PATTERNS = [
  'eslint-disable',
  '@ts-ignore',
  '@ts-nocheck',
  '@ts-expect-error\\s*[:-]?\\s*$',
  'prettier-ignore',
  'biome-ignore',
  'stylelint-disable',
  'nosonar',
  '#\\s*noqa',
  '#\\s*type:\\s*ignore',
  '//\\s*@flow-ignore',
  'istanbul ignore',
  'c8 ignore',
  'pylint:\\s*disable',
  'pyright:\\s*ignore',
  '//\\s*nolint',
  '#\\[allow\\(',
  '#pragma\\s+warning\\s+disable',
  '@SuppressWarnings',
];

// Basenames; `*` matches within one name.
const DEFAULT_WATCHED_CONFIG_FILES = [
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
  'tsconfig.json',
  'tsconfig.*.json',
  'jsconfig.json',
  '.prettierrc',
  '.prettierrc.json',
  'biome.json',
  '.stylelintrc',
  '.stylelintrc.json',
  'package.json',
];

const DEFAULT_ESCAPE_HATCH = 'lint-ok:';

const NON_SOURCE_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.lock', '.log']);

// ── Config weakening ────────────────────────────────────────────────────────────────
const RULES_SECTION_PATTERN = /(?:^|[\s{,])["']?(?:rules|overrides)["']?\s*:/;
const LINTER_SECTION_PATTERN = /["']linter["']\s*:/;
const STRICTNESS_OFF_PATTERN =
  /["'](?:strict|noImplicitAny|strictNullChecks|checkJs)["']\s*:\s*false/;
const LINTER_DISABLED_PATTERN = /["']enabled["']\s*:\s*false/;
const TS_NOCHECK_PATTERN = /@ts-nocheck/i;
const DISABLING_TOKEN_PATTERN = /^["']?(?:off|warn|0)["']?(?=\s*(?:[,}\]]|$))/i;
const RULE_LIKE_KEY = /[/-]/;
const KEY_CHARACTER = /[\w@./-]/;

function hasSectionBefore(lines, index, sectionPattern) {
  for (let cursor = index; cursor >= 0; cursor -= 1)
    if (sectionPattern.test(lines[cursor])) return true;
  return false;
}

function isDisablingValue(rest) {
  const value = rest.trimStart().replace(/^\[\s*/, '');
  return DISABLING_TOKEN_PATTERN.test(value);
}

// Each `key: value` on the line, located by walking back from every colon (a regex over
// the key run is quadratic on colon-less lines).
function assignmentsOf(line) {
  const found = [];
  for (
    let colon = line.indexOf(':');
    colon !== -1;
    colon = line.indexOf(':', colon + 1)
  ) {
    let end = colon;
    while (end > 0 && /\s/.test(line[end - 1])) end -= 1;
    if (end > 0 && (line[end - 1] === '"' || line[end - 1] === "'")) end -= 1;
    let start = end;
    while (start > 0 && KEY_CHARACTER.test(line[start - 1])) start -= 1;
    if (start < end)
      found.push({ key: line.slice(start, end), rest: line.slice(colon + 1) });
  }
  return found;
}

function assignsDisablingValue(line, index, lines) {
  for (const { key, rest } of assignmentsOf(line)) {
    if (!isDisablingValue(rest)) continue;
    if (RULE_LIKE_KEY.test(key)) return true;
    if (hasSectionBefore(lines, index, RULES_SECTION_PATTERN)) return true;
  }
  return false;
}

function weakensConfig(lines, index) {
  const line = lines[index];
  if (STRICTNESS_OFF_PATTERN.test(line) || TS_NOCHECK_PATTERN.test(line))
    return true;
  if (
    LINTER_DISABLED_PATTERN.test(line) &&
    hasSectionBefore(lines, index, LINTER_SECTION_PATTERN)
  )
    return true;
  return assignsDisablingValue(line, index, lines);
}

function watchedFilePatterns(names) {
  return compileRegexList(
    names.map((name) => `^${escapeRegExp(name).replace(/\\\*/g, '[^/]*')}$`),
  ).patterns;
}

function isWatchedConfig(filePath, content, watchedConfigFiles) {
  const name = basename(filePath.replace(/\\/g, '/'));
  if (name === 'package.json' && !content.includes('eslintConfig'))
    return false;
  return watchedFilePatterns(watchedConfigFiles).some((pattern) =>
    pattern.test(name),
  );
}

// ── Lines already on disk are not new suppressions ──────────────────────────────────
// Counted, not just collected: a directive the file already has once does not license a
// second identical one.
function existingLineCounts(filePath, root) {
  const counts = new Map();
  const resolved = resolve(root, filePath);
  try {
    if (!existsSync(resolved)) return counts;
    for (const line of readFileSync(resolved, 'utf8').split('\n')) {
      const trimmed = line.trim();
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
  } catch {
    counts.clear();
  }
  return counts;
}

function consumeExisting(existing, trimmed) {
  const remaining = existing.get(trimmed) ?? 0;
  if (remaining === 0) return false;
  existing.set(trimmed, remaining - 1);
  return true;
}

function firstOffendingLine({
  content,
  inlinePatterns,
  isConfig,
  escapeHatch,
  existing,
}) {
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || consumeExisting(existing, trimmed)) continue;
    if (escapeHatch && line.includes(escapeHatch)) continue;
    if (inlinePatterns.some((pattern) => pattern.test(line))) return trimmed;
    if (isConfig && weakensConfig(lines, index)) return trimmed;
  }
  return null;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      suppressionPatterns: DEFAULT_SUPPRESSION_PATTERNS,
      watchedConfigFiles: DEFAULT_WATCHED_CONFIG_FILES,
      escapeHatch: DEFAULT_ESCAPE_HATCH,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['write'])) return;

    const filePath = writtenPathOf(toolInput);
    const content = writtenContentOf(toolInput);
    if (!filePath || !content) return;

    const isConfig = isWatchedConfig(
      filePath,
      content,
      parameters.watchedConfigFiles,
    );
    if (!isConfig && NON_SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase()))
      return;

    const escapeHatch = String(parameters.escapeHatch ?? '');
    const offender = firstOffendingLine({
      content,
      inlinePatterns: compileRegexList(parameters.suppressionPatterns).patterns,
      isConfig,
      escapeHatch,
      existing: existingLineCounts(filePath, projectRootOf(cwd) ?? cwd),
    });
    if (!offender) return;

    deny(
      CONFIG_KEY,
      `This write silences the linter/type-checker instead of fixing the code: "${offender}". ` +
        'Fix the underlying issue rather than turning the check off. If this is a genuine, ' +
        `documented false positive, put "${escapeHatch} <reason>" on the same line so the ` +
        `reason lives next to the suppression, or set ${CONFIG_KEY} in .ai/config.json.`,
    );
  },
);
