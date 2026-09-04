// circuit-breaker PostToolUse tracker — records a delegation attempt AFTER it was allowed
// by all PreToolUse hooks (including this gate's own). A delegation rejected by another
// gate (intent-flow, brief-before-delegate, etc.) never reaches PostToolUse, so it does
// not inflate the retry counter. Without this split, the PreToolUse gate counted rejected
// delegations as retries and tripped the breaker on the corrected second attempt.

import { createHash } from 'node:crypto';
import { isGateEnabled } from '../../lib/config.mjs';
import {
  allow,
  delegationPromptOf,
  readHookPayload,
  sessionIdOf,
  toolInputOf,
  toolNameOf,
  toolInGroups,
} from '../../lib/hook-io.mjs';
import {
  readSessionState,
  writeSessionState,
} from '../../lib/session-state.mjs';

const GATE_ID = 'circuit-breaker';
const CONFIG_KEY = 'requireCircuitBreakerOnDelegation';

const MAX_ENTRIES_PER_KEY = 12;
const MIN_TOKEN_LENGTH = 2;

const SECTION_HEADING_NAMES = [
  'scope',
  'steps',
  'haceres',
  'output',
  'criteria',
  'criterio',
  'handoff',
  'out of scope',
  'in scope',
  'que no',
  'que si',
  'que sí',
  'edge cases',
  'casos borde',
];

function headingNamePattern(name) {
  return new RegExp(
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'),
    'i',
  );
}

const HEADING_NAME_PATTERNS = SECTION_HEADING_NAMES.map(headingNamePattern);

function indexOfSectionMarker(text) {
  let earliest = -1;
  for (const namePattern of HEADING_NAME_PATTERNS) {
    const match = namePattern.exec(text);
    if (!match) continue;
    const after = text.slice(match.index + match[0].length);
    if (!/^\s*:/.test(after)) continue;
    if (earliest === -1 || match.index < earliest) earliest = match.index;
  }
  return earliest;
}

const LEVEL_LINE_PATTERNS = [
  new RegExp('^level\\s*:?$', 'i'),
  new RegExp('^nivel\\s*:?$', 'i'),
];

function stripLeadingMarkup(line) {
  return line
    .trim()
    .replace(/^#{1,4}\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^\*\*/, '');
}

function isScaffoldingLine(line) {
  const stripped = stripLeadingMarkup(line);
  if (LEVEL_LINE_PATTERNS.some((pattern) => pattern.test(stripped)))
    return true;
  return HEADING_NAME_PATTERNS.some((namePattern) => {
    const match = namePattern.exec(stripped);
    return (
      match &&
      match.index === 0 &&
      /^\s*:?$/.test(stripped.slice(match[0].length))
    );
  });
}

const GOAL_HEADING_PATTERN = /^(objetivo|goal|meta):(.*)$/i;
const IN_SCOPE_HEADING_PATTERN = /^(que\s+s[ií]|in\s+scope|lo\s+pedido)\b/i;

function isEndOfInScope(line) {
  const stripped = stripLeadingMarkup(line);
  return HEADING_NAME_PATTERNS.some((namePattern) => {
    const match = namePattern.exec(stripped);
    return match && match.index === 0;
  });
}

function contentAfterHeading(line) {
  const colon = line.indexOf(':');
  return colon === -1 ? '' : line.slice(colon + 1).trim();
}

const STOP_WORDS = new Set(
  (
    'de la el los las un una unos unas y o a en del al lo que se su sus por para con como es son ser este esta ' +
    'esto ese esa eso mas si no ni pero cuando donde cual cuales hay hace hacer debe deben debes puede pueden ' +
    'the of to and in for on with a an is are be it its this that'
  ).split(' '),
);

function stripDiacritics(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

function tokenize(text) {
  return stripDiacritics(String(text).toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter(
      (token) => token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token),
    );
}

const WINDOWS_DRIVE_PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'`,;)\]]+/g;
const KNOWN_EXTENSIONS = [
  'mjs',
  'cjs',
  'json',
  'jsx',
  'js',
  'mts',
  'cts',
  'tsx',
  'ts',
  'vue',
  'md',
  'py',
  'sh',
  'ps1',
  'yaml',
  'yml',
  'toml',
  'sql',
  'css',
  'html',
];
const KNOWN_EXTENSION_FILENAME_PATTERN = new RegExp(
  `[\\w-]+\\.(?:${KNOWN_EXTENSIONS.join('|')})\\b`,
  'g',
);
const PATH_LIKE_RUN_PATTERN = /[\w./\\-]+/g;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', ')', ']']);

function looksLikeRelativePath(run) {
  return /[\\/]/.test(run) && !/^[\\/]+$/.test(run);
}

function stripTrailingPunctuation(text) {
  let end = text.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

function mentionedPaths(prompt) {
  const found = new Set();
  const text = String(prompt);
  const fixedShapeMatches = [
    WINDOWS_DRIVE_PATH_PATTERN,
    KNOWN_EXTENSION_FILENAME_PATTERN,
  ].flatMap((pattern) => text.match(pattern) ?? []);
  const relativePathMatches = (text.match(PATH_LIKE_RUN_PATTERN) ?? []).filter(
    looksLikeRelativePath,
  );
  for (const raw of [...fixedShapeMatches, ...relativePathMatches]) {
    const normalized = stripTrailingPunctuation(
      stripDiacritics(raw.toLowerCase()).replace(/\\/g, '/'),
    );
    const base = normalized.split('/').filter(Boolean).pop();
    if (base && /[a-z0-9]/.test(base)) found.add(base);
  }
  return [...found].sort();
}

function identityText(prompt) {
  const lines = String(prompt).split(/\r?\n/);
  const parts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const strippedLine = stripLeadingMarkup(lines[index])
      .replace(/\*\*\s*/g, '')
      .replace(' :', ':');
    const goal = strippedLine.match(GOAL_HEADING_PATTERN);
    if (goal) {
      const goalText = goal[2].trim();
      const cut = indexOfSectionMarker(goalText);
      parts.push(cut > 0 ? goalText.slice(0, cut) : goalText);
      continue;
    }
    if (IN_SCOPE_HEADING_PATTERN.test(strippedLine)) {
      parts.push(contentAfterHeading(strippedLine));
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (isEndOfInScope(lines[cursor])) break;
        parts.push(lines[cursor]);
      }
    }
  }
  return parts.join(' ').trim();
}

function textWithoutScaffolding(prompt) {
  return String(prompt)
    .split(/\r?\n/)
    .filter((line) => !isScaffoldingLine(line))
    .join(' ')
    .trim();
}

function identitySignature(prompt) {
  const identity =
    identityText(prompt) || textWithoutScaffolding(prompt) || String(prompt);
  const tokens = tokenize(identity);
  const features = [];
  if (tokens.length >= 2) {
    for (let index = 0; index < tokens.length - 1; index += 1)
      features.push(`${tokens[index]} ${tokens[index + 1]}`);
  } else {
    features.push(...tokens);
  }
  for (const path of mentionedPaths(prompt))
    features.push(`path:${path}`, `path:${path}`);
  return features;
}

function identityKey(signature) {
  return createHash('sha256').update(signature.join(' ')).digest('hex');
}

function occurrencesFor(state, key) {
  const value = state[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && Array.isArray(entry.signature));
}

function main() {
  const rawPayload = readHookPayload();
  if (rawPayload === null) allow();
  const toolName = toolNameOf(rawPayload) ?? '';
  if (!toolInGroups(toolName, ['delegation'])) allow();

  const cwd = process.cwd();
  if (!isGateEnabled(CONFIG_KEY, false, cwd)) allow();

  const toolInput = toolInputOf(rawPayload);
  const prompt = delegationPromptOf(toolInput);
  if (!prompt.trim()) allow();

  const sessionId = sessionIdOf(rawPayload);
  const stateOptions = { cwd };
  const state = readSessionState(GATE_ID, sessionId, {}, stateOptions);
  const signature = identitySignature(prompt);
  const key = identityKey(signature);

  const occurrences = [
    ...occurrencesFor(state, key),
    { signature, seenAt: Date.now() },
  ].slice(-MAX_ENTRIES_PER_KEY);
  writeSessionState(
    GATE_ID,
    sessionId,
    { ...state, [key]: occurrences },
    stateOptions,
  );
  allow();
}

try {
  main();
} catch {
  allow();
}
