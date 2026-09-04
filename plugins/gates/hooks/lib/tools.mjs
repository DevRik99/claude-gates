// tools.mjs — what counts as a "tool/helper" file and what counts as evidence that the
// wheel was checked before building one. Shared by the discovery gates (reuse-before-build,
// tool-map, audit-before-build), which previously carried three divergent copies of these
// lists and three different audit-evidence regexes — so a build audited in Spanish was
// allowed by one gate and never recorded by the other.
//
// Self-contained: Node built-ins only (plus signals.mjs, this plugin's own).

import { withUnicodeWordBoundary } from './signals.mjs';

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

/** Whether any path SEGMENT (not substring) is one of `folders`, case-insensitively. */
export function isUnderToolFolder(path, folders = DEFAULT_TOOL_FOLDERS) {
  const wanted = new Set(folders.map((folder) => String(folder).toLowerCase()));
  return segmentsOf(path)
    .slice(0, -1)
    .some((segment) => wanted.has(segment.toLowerCase()));
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
  if (isTestPath(path)) return false;
  return isUnderToolFolder(path, folders) || hasToolName(path, namePatterns);
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
