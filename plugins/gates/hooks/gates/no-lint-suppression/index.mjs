// no-lint-suppression — denies a write that SILENCES the linter/type-checker instead of
// fixing the code it complains about. Turning a rule off, adding an inline disable, or
// widening an ignore list is the lazy path ("it is easier to disable the linter than to fix
// it"); this gate makes that path a deliberate, escape-hatched choice rather than a default.
//
// justification: no existing gate covers this. lint-commit RUNS the linter and blocks a
// commit when it fails, but a suppression makes the linter pass — so lint-commit goes green
// precisely when the code got worse. This gate reads the WRITE, not the lint result, and is
// the only one that catches "made it pass by turning the check off".
//
// The defect is fully visible in the content being written (the disable directive, the rule
// set to "off", the added @ts-ignore), so this is a deterministic deny with an escape hatch —
// not a prose reminder. A legitimate suppression (a documented false positive) is allowed by
// putting the escape hatch on the SAME line as the directive, which also forces a reason to
// live next to it in the diff.
//
// ── What this catches ────────────────────────────────────────────────────────────────
//   inline directives in any source file:
//     // eslint-disable, /* eslint-disable */, // eslint-disable-next-line,
//     // @ts-ignore, // @ts-nocheck, # type: ignore, # noqa, // prettier-ignore,
//     // biome-ignore, // stylelint-disable, // NOSONAR
//   config edits that weaken the ruleset, in eslint/tsconfig/prettier/biome/stylelint config:
//     a rule set to "off" / 0, "@ts-nocheck", disabling strict, or "ignore" additions.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   suppressionPatterns  regex sources (case-insensitive) that mark a line as a
//                        suppression. Replaces the built-in list wholesale.
//   escapeHatch          substring that, present on the same line as a suppression, allows
//                        it — so a real false positive is annotated, not smuggled. Default
//                        'lint-ok:' (write e.g. `// eslint-disable-next-line ... lint-ok: <reason>`).
//   watchedConfigFiles   basenames whose edits are also scanned for rule-weakening. Replaces
//                        the built-in list.
//
// ── Fail-safe shape ──────────────────────────────────────────────────────────────────
// A non-write tool, or a write with no suppression line: allow (silent). A write that adds a
// suppression line WITHOUT the escape hatch on that same line: deny, naming the line.

import { extname } from 'node:path';
import {
  runGate,
  deny,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'no-lint-suppression';
const CONFIG_KEY = 'blockLintSuppression';

// Inline suppression directives across the common linters/type-checkers. Sources, compiled
// case-insensitively and matched one line at a time.
const DEFAULT_SUPPRESSION_PATTERNS = [
  String.raw`eslint-disable`,
  String.raw`@ts-ignore`,
  String.raw`@ts-nocheck`,
  String.raw`@ts-expect-error`,
  String.raw`prettier-ignore`,
  String.raw`biome-ignore`,
  String.raw`stylelint-disable`,
  String.raw`nosonar`,
  String.raw`#\s*noqa`,
  String.raw`#\s*type:\s*ignore`,
  String.raw`//\s*@flow-ignore`,
  String.raw`istanbul ignore`,
];

// Config files whose edits are scanned for rule-weakening (a rule set off, strict disabled).
const DEFAULT_WATCHED_CONFIG_FILES = [
  'eslint.config.mjs',
  'eslint.config.js',
  'eslint.config.cjs',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'tsconfig.json',
  '.prettierrc',
  'biome.json',
  '.stylelintrc',
  '.stylelintrc.json',
];

// Inside a watched config file, these mark a rule being turned off or a check being weakened.
const CONFIG_WEAKENING_PATTERNS = [
  // a rule mapped to "off" or 0:  "no-unused-vars": "off"   'rule': 0
  // (no trailing \b: the value can end in a quote, which is a non-word char, so \b would
  // never match after "off" and silently miss every quoted "off")
  String.raw`["'][^"']+["']\s*:\s*(?:["']off["']|0)(?:\s|,|}|$)`,
  // strict / type-checking disabled in tsconfig
  String.raw`"(?:strict|noImplicitAny|strictNullChecks|checkJs)"\s*:\s*false`,
  String.raw`@ts-nocheck`,
];

const DEFAULT_ESCAPE_HATCH = 'lint-ok:';

function compile(sources) {
  const compiled = [];
  for (const source of sources) {
    try {
      compiled.push(new RegExp(source, 'i'));
    } catch {
      // Skip a malformed override pattern rather than crashing; the rest still protect.
    }
  }
  return compiled;
}

function baseNameOf(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function isWatchedConfig(filePath, watchedConfigFiles) {
  return watchedConfigFiles.includes(baseNameOf(filePath));
}

// A code file's inline directives count everywhere; a config file's edits are read with the
// rule-weakening patterns instead. We never guess a language — the directives are recognizable
// on their own.
const NON_SOURCE_EXTENSIONS = new Set(['.md', '.txt', '.lock', '.log']);

function isPlausibleSource(filePath) {
  return !NON_SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/** The first written line matching any pattern and lacking the escape hatch, or null. */
function offendingLine(content, patterns, escapeHatch) {
  for (const line of content.split('\n')) {
    if (escapeHatch && line.includes(escapeHatch)) continue;
    if (patterns.some((pattern) => pattern.test(line))) return line.trim();
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
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['write'])) return;

    const filePath = writtenPathOf(toolInput);
    if (!filePath) return;

    const content = writtenContentOf(toolInput);
    if (!content) return;

    const escapeHatch = parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH;

    // Config files: scan for rule-weakening. Any source file: scan for inline suppressions.
    const isConfig = isWatchedConfig(filePath, parameters.watchedConfigFiles);
    const inlinePatterns = compile(parameters.suppressionPatterns);
    const configPatterns = compile(CONFIG_WEAKENING_PATTERNS);

    // A config file is scanned for both inline directives and rule-weakening; any other
    // plausible source file only for inline directives; a non-source file (docs, lockfiles)
    // is not scanned at all.
    let patterns = [];
    if (isConfig) patterns = [...inlinePatterns, ...configPatterns];
    else if (isPlausibleSource(filePath)) patterns = inlinePatterns;
    if (patterns.length === 0) return;

    const offender = offendingLine(content, patterns, escapeHatch);
    if (!offender) return;

    deny(
      CONFIG_KEY,
      `This write silences the linter/type-checker instead of fixing the code: "${offender}". ` +
        'Fix the underlying issue rather than turning the check off. If this is a genuine, ' +
        `documented false positive, put "${escapeHatch} <reason>" on the same line so the ` +
        'reason lives next to the suppression, or set blockLintSuppression in .ai/config.json.',
    );
  },
);
