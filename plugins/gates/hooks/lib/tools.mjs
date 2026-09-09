// tools.mjs — what counts as a "tool/helper" file, what counts as intent to build one, and
// what counts as evidence that the wheel was checked first. Shared by the discovery gates
// (reuse-before-build, tool-map), which previously carried divergent copies of these lists
// and different audit-evidence regexes — so a build audited in Spanish was allowed by one
// gate and never recorded by the other.
//
// audit-before-build used to live beside reuse-before-build asking the same question with a
// narrower folder list and only one accepted answer; it was folded in here, and the two
// things it did better (masking the false positives of the build-intent match, and never
// treating a vendored path as the project's own new tool) are now what every caller gets.
//
// Self-contained: Node built-ins only (plus signals.mjs, this plugin's own).

import { isBuildIntent, withUnicodeWordBoundary } from './signals.mjs';

/** Folder names (path segments) that mark a file as a tool/helper. */
export const DEFAULT_TOOL_FOLDERS = [
  'scripts',
  'hooks',
  'tools',
  'gates',
  'lib',
  'utils',
  'util',
  'helpers',
  'composables',
  'components',
  'services',
  'shared',
  'common',
  'plugins',
  'bin',
];

/** Extensions of code that can reinvent a wheel. */
export const DEFAULT_TOOL_EXTENSIONS = [
  '.mjs',
  '.cjs',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.py',
  '.sh',
  '.ps1',
  '.go',
  '.rs',
];

/** Regex sources; a new file whose basename matches any is a helper regardless of folder. */
export const DEFAULT_TOOL_NAME_PATTERNS = [
  String.raw`^use[A-Z]\w*\.`,
  String.raw`(?:^|[-.])(?:helper|helpers|util|utils|service|wrapper|adapter|client|gate|hook|plugin)\.`,
  String.raw`[A-Z]\w*(?:Helper|Util|Utils|Service|Wrapper|Adapter|Client)\.`,
];

/** Vendored or VCS-internal trees: never the project's own new tool. */
const FOREIGN_SEGMENTS = new Set(['.git', 'node_modules', 'vendor', 'dist']);

/** File-name markers of a test or fixture: never a tool to reuse. */
const TEST_FILE_PATTERNS = [
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress)\//i,
  /\.(?:test|spec|stories)\.[\w.]+$/i,
  /(?:^|\/)test\.mjs$/i,
];

/** Whether a path is a test/spec/fixture file. */
export function isTestPath(path) {
  const normalized = String(path ?? '').replace(/\\/g, '/');
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function segmentsOf(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
}

/**
 * Whether any path SEGMENT (not substring) is one of `folders`, case-insensitively. A
 * configured folder keeps working when it was written as a path ("scripts/"), because that
 * is how people write folders and a trailing slash never matched a segment.
 */
export function isUnderToolFolder(path, folders = DEFAULT_TOOL_FOLDERS) {
  const wanted = new Set(
    folders.map((folder) => (segmentsOf(folder).at(-1) ?? '').toLowerCase()),
  );
  return segmentsOf(path)
    .slice(0, -1)
    .some((segment) => wanted.has(segment.toLowerCase()));
}

export function isForeignPath(path) {
  return segmentsOf(path).some((segment) =>
    FOREIGN_SEGMENTS.has(segment.toLowerCase()),
  );
}

/** Whether the basename matches any of the tool-name patterns (invalid ones skipped). */
export function hasToolName(path, patterns = DEFAULT_TOOL_NAME_PATTERNS) {
  const base = segmentsOf(path).at(-1) ?? '';
  return patterns.some((source) => {
    try {
      return new RegExp(source).test(base);
    } catch {
      return false;
    }
  });
}

/** Whether the path's extension is one of `extensions` (each with its leading dot). */
export function hasToolExtension(path, extensions = DEFAULT_TOOL_EXTENSIONS) {
  const lowered = String(path ?? '').toLowerCase();
  return extensions.some((extension) =>
    lowered.endsWith(String(extension).toLowerCase()),
  );
}

/**
 * Whether a written path is a tool/helper worth a reuse check: code by extension, not a
 * test, and either under a tool folder or named like a helper.
 */
export function isToolPath(
  path,
  {
    folders = DEFAULT_TOOL_FOLDERS,
    extensions = DEFAULT_TOOL_EXTENSIONS,
    namePatterns = DEFAULT_TOOL_NAME_PATTERNS,
  } = {},
) {
  if (!path || !hasToolExtension(path, extensions)) return false;
  if (isTestPath(path) || isForeignPath(path)) return false;
  return isUnderToolFolder(path, folders) || hasToolName(path, namePatterns);
}

// Because "the build script" is a noun phrase and "add tests for the gate" builds a test,
// both read literally as a creation verb next to a tool noun. They are masked before the
// match instead of after, so the intent check stays usable on real prompts.
const BUILD_AS_NOUN_PATTERN =
  /\b(?:the|a|an|this|that|our|your|my|el|la|un|una|este|esta)\s+build\b/giu;
const CREATION_VERBS =
  'write|create|build|implement|add|make|escribe|escribi|escribir|crea|construye|' +
  'construir|implementa|implementar|agrega|arma|hace|genera|generar|armá|hacé|creá|' +
  'agregá|generá|escribí|construí';
const OBJECT_QUALIFIERS =
  'a|the|some|new|more|unos|unas|los|las|más|nuevos|nuevas';
const TEST_OBJECT_NOUNS = 'tests?|specs?|pruebas?';
const TEST_OBJECT_PATTERN = new RegExp(
  String.raw`\b(?:${CREATION_VERBS})\s+(?:(?:${OBJECT_QUALIFIERS})\s+){0,2}(?:${TEST_OBJECT_NOUNS})\b`,
  'giu',
);

export function isNewToolIntent(prompt) {
  const masked = String(prompt ?? '')
    .replace(BUILD_AS_NOUN_PATTERN, 'it')
    .replace(TEST_OBJECT_PATTERN, 'tests');
  return isBuildIntent(masked);
}

// Evidence that the wheel was checked, Spanish and English: a sentence stating that no
// existing tool/helper covers this, or that the existing ones were audited/reviewed.
const AUDIT_DONE_SOURCES = [
  'no existing (?:tool|helper|script|gate|hook|utility|module|library|dependency)',
  'no (?:tool|helper|script|gate|hook|utility) (?:covers|does|exists|handles)',
  'nothing (?:existing|in the (?:repo|codebase|map)) covers',
  'checked (?:the )?(?:tool map|existing (?:tools|helpers|code)|whether)',
  'audited (?:the )?(?:tool map|existing|dependencies)',
  'reuse (?:check|audit) done',
  'justification:',
  'no existe (?:una |un |ninguna |ning[uú]n )?(?:herramienta|helper|script|gate|hook|utilidad|m[oó]dulo|librer[ií]a|dependencia)',
  'ning(?:una|[uú]n) (?:herramienta|helper|script|gate|hook|utilidad) (?:cubre|existe|hace|resuelve)',
  'revis(?:é|e|amos|ado) (?:el mapa|las herramientas|el c[oó]digo existente|lo existente)',
  'audit(?:é|e|amos|ado) (?:el mapa|las herramientas|lo existente|las dependencias)',
  'justificaci[oó]n:',
];

/** Matches prose that states the reuse audit was done (ES + EN). */
export const AUDIT_DONE_PATTERN = withUnicodeWordBoundary(
  AUDIT_DONE_SOURCES.join('|'),
);

/** Whether the text carries an audit statement. */
export function hasAuditEvidence(text) {
  return AUDIT_DONE_PATTERN.test(String(text ?? ''));
}
