import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  compileRegexList,
  deny,
  runGate,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';
import { withUnicodeWordBoundary } from '../../lib/signals.mjs';

const GATE_ID = 'no-explanatory-comments';
const CONFIG_KEY = 'blockExplanatoryComments';

const SLASH_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.php',
  '.scss',
  '.css',
];
const HASH_EXTENSIONS = ['.py', '.sh', '.bash', '.ps1', '.rb', '.pl', '.r'];
const DASH_EXTENSIONS = ['.sql', '.lua'];

const DEFAULT_DECISION_MARKERS = [
  'because|why|so that|otherwise|instead of|rather than|trade-?offs?|decision|deliberate(?:ly)?|intentional(?:ly)?|on purpose',
  "workaround|known (?:issue|limitation)|limitation|invariant|must(?: not| never)?|never|cannot|can't|do not|don't|avoid|guard(?:s|ed)?|edge cases?|race|compat\\p{L}*|legacy|deprecated|perf\\p{L}*|security|unsafe|fail-?(?:safe|open|closed)",
  'porque|por qu[eé]|para que|si no|en vez de|en lugar de|decisi[oó]n|deliberad\\p{L}*|intencional\\p{L}*|a prop[oó]sito|limitaci[oó]n|invariante|nunca|no debe|evita\\p{L}*|compatibilidad|rendimiento|seguridad|casos? borde|justificaci[oó]n',
];
const DEFAULT_ESCAPE_HATCH = 'comment-ok:';
const MAX_REPORTED = 5;
const MAX_LINE_LENGTH = 90;

const DIRECTIVE_PREFIXES = [
  '#!',
  '#pragma',
  '#include',
  '#define',
  '#if',
  '#endif',
  '#else',
  '#region',
  '#endregion',
  '#[',
  '@license',
  'spdx-',
  'eslint',
  'prettier',
  'cspell',
  '@ts-',
  'c8 ',
  'istanbul ',
  'noqa',
  'pylint',
  'pyright',
  'nolint',
  'type:',
  'neutral-spanish:allow',
  'lint-ok:',
  'justification:',
  'justificación:',
  'justificacion:',
  'http://',
  'https://',
];
const DIRECTIVE_WORD_PATTERN = /^(?:todo|fixme|hack|note|xxx)\b/i;
const JSDOC_TAG_PATTERN =
  /^@(?:type|typedef|template|deprecated|throws|see|example)\b|^@(?:param|returns?) \{/i;

function isDirective(line) {
  const lowered = line.trim().toLowerCase();
  if (DIRECTIVE_PREFIXES.some((prefix) => lowered.startsWith(prefix)))
    return true;
  return (
    DIRECTIVE_WORD_PATTERN.test(lowered) || JSDOC_TAG_PATTERN.test(lowered)
  );
}

function commentStyleOf(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (SLASH_EXTENSIONS.includes(extension)) return 'slash';
  if (HASH_EXTENSIONS.includes(extension)) return 'hash';
  if (DASH_EXTENSIONS.includes(extension)) return 'dash';
  return null;
}

function stripLeading(text, characters) {
  let start = 0;
  while (start < text.length && characters.includes(text[start])) start += 1;
  return text.slice(start);
}

function stripSlashMarkers(text) {
  let body = text.trim();
  if (body.endsWith('*/')) body = body.slice(0, -'*/'.length);
  while (body.endsWith('*')) body = body.slice(0, -1);
  if (body.startsWith('//')) body = stripLeading(body, '/');
  else if (body.startsWith('/*')) body = stripLeading(body.slice(1), '*');
  else body = stripLeading(body, '*');
  return body.trim();
}

function slashComments(content) {
  const units = [];
  let block = null;
  let lineRun = [];
  const flushRun = () => {
    if (lineRun.length > 0) units.push(lineRun);
    lineRun = [];
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (block) {
      block.push(stripSlashMarkers(line));
      if (line.includes('*/')) {
        units.push(block);
        block = null;
      }
      continue;
    }
    const blockStart = line.indexOf('/*');
    const quoteAt = line.search(/['"`]/);
    if (blockStart !== -1 && (quoteAt === -1 || quoteAt > blockStart)) {
      flushRun();
      block = [stripSlashMarkers(line.slice(blockStart))];
      if (line.indexOf('*/', blockStart + 2) !== -1) {
        units.push(block);
        block = null;
      }
      continue;
    }
    const lineStart = line.indexOf('//');
    const isCommentLine = line.startsWith('//');
    const isTrailing =
      lineStart > 0 &&
      !/['"`]/.test(line.slice(0, lineStart)) &&
      !line.slice(0, lineStart).includes(':');
    if (isCommentLine) {
      lineRun.push(stripSlashMarkers(line));
      continue;
    }
    flushRun();
    if (isTrailing) units.push([stripSlashMarkers(line.slice(lineStart))]);
  }
  flushRun();
  if (block) units.push(block);
  return units;
}

function prefixComments(content, prefix) {
  const units = [];
  let run = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith(prefix)) {
      run.push(line.slice(prefix.length).trim());
      continue;
    }
    if (run.length > 0) units.push(run);
    run = [];
    const at = line.indexOf(` ${prefix}`);
    if (at > 0 && !/['"]/.test(line.slice(0, at)))
      units.push([line.slice(at + prefix.length + 1).trim()]);
  }
  if (run.length > 0) units.push(run);
  return units;
}

export function commentUnitsOf(content, filePath) {
  const style = commentStyleOf(filePath);
  if (style === 'slash') return slashComments(content);
  if (style === 'hash') return prefixComments(content, '#');
  if (style === 'dash') return prefixComments(content, '--');
  return [];
}

function unitKey(unit) {
  return unit
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function isAllowed(unit, markers, escapeHatch) {
  const text = unitKey(unit);
  if (!text) return true;
  const lowered = text.toLowerCase();
  if (escapeHatch && lowered.includes(escapeHatch.toLowerCase())) return true;
  if (unit.some((line) => isDirective(line))) return true;
  return markers.some((pattern) => pattern.test(text));
}

function previousContent(toolInput, absolutePath) {
  if (typeof toolInput.old_string === 'string') return toolInput.old_string;
  if (Array.isArray(toolInput.edits))
    return toolInput.edits
      .map((edit) => String(edit?.old_string ?? ''))
      .join('\n');
  if (!existsSync(absolutePath)) return '';
  try {
    return statSync(absolutePath).isFile()
      ? readFileSync(absolutePath, 'utf8')
      : '';
  } catch {
    return '';
  }
}

function excerpt(unit) {
  const text = unit.filter(Boolean).join(' ');
  return text.length > MAX_LINE_LENGTH
    ? `${text.slice(0, MAX_LINE_LENGTH)}…`
    : text;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      decisionMarkers: DEFAULT_DECISION_MARKERS,
      escapeHatch: DEFAULT_ESCAPE_HATCH,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['write'])) return;
    const filePath = writtenPathOf(toolInput);
    if (!commentStyleOf(filePath)) return;
    const content = writtenContentOf(toolInput);
    if (!content) return;
    const root = projectRootOf(cwd) ?? cwd;
    const absolutePath = isAbsolute(filePath) ? filePath : join(root, filePath);
    const before = new Set(
      commentUnitsOf(previousContent(toolInput, absolutePath), filePath).map(
        unitKey,
      ),
    );
    const markers = compileRegexList(
      parameters.decisionMarkers,
      'iu',
    ).patterns.map((pattern) => withUnicodeWordBoundary(pattern.source));
    const offending = commentUnitsOf(content, filePath)
      .filter((unit) => !before.has(unitKey(unit)))
      .filter((unit) => !isAllowed(unit, markers, parameters.escapeHatch));
    if (offending.length === 0) return;
    const shown = offending
      .slice(0, MAX_REPORTED)
      .map((unit) => `"${excerpt(unit)}"`);
    const more =
      offending.length > MAX_REPORTED
        ? ` (+${offending.length - MAX_REPORTED} more)`
        : '';
    deny(
      CONFIG_KEY,
      `This write adds ${offending.length} comment(s) that explain what the code does instead of recording a ` +
        `decision: ${shown.join('; ')}${more}. Make the code say it (a clearer name, a small extracted function) ` +
        'and delete the comment, or keep only the WHY (start with because/porque, so that/para que, instead of/en vez de, ' +
        `a trade-off or a known limitation). For a documented exception add "${parameters.escapeHatch} <reason>" in the comment.`,
    );
  },
);
