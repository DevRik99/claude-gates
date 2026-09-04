// circuit-breaker — cuts the same delegation retried without substantial change within a
// session. A hook cannot see why a previous attempt did not land, but relaunching an
// essentially identical prompt is the signal that it did not.
//
// Decisions: identity is an extracted signature (GOAL line, IN SCOPE body, mentioned paths)
// compared by Dice over word bigrams, not the raw prompt — the shared delegation template
// would otherwise make unrelated tasks look alike. The attempt count is recomputed from
// stored signatures across every key (a one-word edit is still the same task), never read
// as a trusted number off disk. The key is a hash of the signature, not the caller-chosen
// subagent_type. An override imperative counts only in a short sentence, so "force it" inside
// a long instruction is task vocabulary, not the user's decision to proceed. A threshold
// below 2 is treated as 2: a first attempt is never a retry.

import { createHash } from 'node:crypto';
import {
  runGate,
  deny,
  escapeRegExp,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import {
  readSessionState,
  writeSessionState,
} from '../../lib/session-state.mjs';

const GATE_ID = 'circuit-breaker';
const CONFIG_KEY = 'requireCircuitBreakerOnDelegation';

const DEFAULT_RETRY_THRESHOLD = 2;
const MIN_RETRY_THRESHOLD = 2;
const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
const MAX_ENTRIES_PER_KEY = 12;
const MAX_OVERRIDE_SENTENCE_WORDS = 8;
const MIN_TOKEN_LENGTH = 2;

const OVERRIDE_BOUNDARY_BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const OVERRIDE_BOUNDARY_AFTER = String.raw`(?![\p{L}\p{N}_])`;
// One short regex per imperative: a single big alternation trips the regex-complexity lint.
const OVERRIDE_ALTERNATIVES = [
  String.raw`reintent[aá]lo`,
  String.raw`reintenta(lo)?`,
  String.raw`forz(alo|á|ar)\b(?!\s+un|\s+una)`,
  String.raw`insist[ií]`,
  String.raw`retry\s+(anyway|it|again|this)`,
  String.raw`force\s+(it|this|anyway)`,
  String.raw`do\s+it\s+anyway`,
];
const OVERRIDE_PATTERNS = OVERRIDE_ALTERNATIVES.map(
  (alternative) =>
    new RegExp(
      `${OVERRIDE_BOUNDARY_BEFORE}(?:${alternative})${OVERRIDE_BOUNDARY_AFTER}`,
      'iu',
    ),
);

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function isOverrideImperative(text) {
  return String(text)
    .split(/[.!?;\n]+/)
    .filter((sentence) => wordCount(sentence) <= MAX_OVERRIDE_SENTENCE_WORDS)
    .some((sentence) =>
      OVERRIDE_PATTERNS.some((pattern) => pattern.test(sentence)),
    );
}

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
  return new RegExp(escapeRegExp(name).replace(/ /g, '\\s+'), 'i');
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
// A flat character class validated in JS afterwards: no nested repeated groups for a
// backtracking engine to explore.
const PATH_LIKE_RUN_PATTERN = /[\w./\\-]+/g;

function looksLikeRelativePath(run) {
  return /[\\/]/.test(run) && !/^[\\/]+$/.test(run);
}

const PATH_PATTERNS = [
  WINDOWS_DRIVE_PATH_PATTERN,
  KNOWN_EXTENSION_FILENAME_PATTERN,
];

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

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', ')', ']']);

function stripTrailingPunctuation(text) {
  let end = text.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

function mentionedPaths(prompt) {
  const found = new Set();
  const text = String(prompt);

  const fixedShapeMatches = PATH_PATTERNS.flatMap(
    (pattern) => text.match(pattern) ?? [],
  );
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

function contentAfterHeading(line) {
  const colon = line.indexOf(':');
  return colon === -1 ? '' : line.slice(colon + 1).trim();
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
    for (let index = 0; index < tokens.length - 1; index += 1) {
      features.push(`${tokens[index]} ${tokens[index + 1]}`);
    }
  } else {
    features.push(...tokens);
  }

  // Paths are duplicated so they weigh more than prose: they discriminate tasks best.
  for (const path of mentionedPaths(prompt)) {
    features.push(`path:${path}`, `path:${path}`);
  }

  return features;
}

function similarity(featuresA, featuresB) {
  if (!Array.isArray(featuresA) || !Array.isArray(featuresB)) return 0;
  if (featuresA.length === 0 || featuresB.length === 0) return 0;

  const counts = new Map();
  for (const feature of featuresA)
    counts.set(feature, (counts.get(feature) ?? 0) + 1);

  let intersection = 0;
  for (const feature of featuresB) {
    const available = counts.get(feature) ?? 0;
    if (available > 0) {
      intersection += 1;
      counts.set(feature, available - 1);
    }
  }

  return (2 * intersection) / (featuresA.length + featuresB.length);
}

function occurrencesFor(state, key) {
  const value = state[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && Array.isArray(entry.signature));
}

function similarOccurrenceCount(state, signature, similarityThreshold) {
  let count = 0;
  for (const key of Object.keys(state)) {
    for (const entry of occurrencesFor(state, key)) {
      if (similarity(entry.signature, signature) >= similarityThreshold)
        count += 1;
    }
  }
  return count;
}

function identityKey(signature) {
  return createHash('sha256').update(signature.join(' ')).digest('hex');
}

function withoutRelatedKeys(state, key, signature, similarityThreshold) {
  const next = { ...state };
  for (const existingKey of Object.keys(next)) {
    const isRelated =
      existingKey === key ||
      occurrencesFor(next, existingKey).some(
        (entry) =>
          similarity(entry.signature, signature) >= similarityThreshold,
      );
    if (isRelated) delete next[existingKey];
  }
  return next;
}

function denyRepeatedAttempt(count) {
  deny(
    CONFIG_KEY,
    `This same task received ${count} consecutive attempts (same goal, same scope and the same files) ` +
      'in this session, regardless of which subagent_type carried it. STOP retrying and ASK THE USER ' +
      'for help now: state what you tried, what blocked it, and the specific decision or input you need ' +
      'from them to move forward. Do not relaunch this same delegation again on your own. Escape hatch: ' +
      'only if the user explicitly authorizes it, include an override imperative ("retry anyway"/"force ' +
      'it"/"insisti") in the next delegation\'s prompt and this gate will allow it and reset the counter.',
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      retryThreshold: DEFAULT_RETRY_THRESHOLD,
      similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    },
  },
  ({ toolName, toolInput, sessionId, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;

    const stateOptions = { cwd };
    const state = readSessionState(GATE_ID, sessionId, {}, stateOptions);
    const signature = identitySignature(prompt);
    const key = identityKey(signature);
    const { similarityThreshold } = parameters;

    if (isOverrideImperative(prompt)) {
      writeSessionState(
        GATE_ID,
        sessionId,
        withoutRelatedKeys(state, key, signature, similarityThreshold),
        stateOptions,
      );
      return;
    }

    const count =
      1 + similarOccurrenceCount(state, signature, similarityThreshold);
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

    const retryThreshold = Math.max(
      MIN_RETRY_THRESHOLD,
      parameters.retryThreshold,
    );
    if (count >= retryThreshold) denyRepeatedAttempt(count);
  },
);
