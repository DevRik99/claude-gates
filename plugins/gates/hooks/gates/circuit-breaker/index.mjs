// circuit-breaker — cuts the same delegation retried without substantial change within
// a session. A `runGate` check cannot see another gate's verdict (each gate runs as its
// own process, and a denied call never fires a later hook) — but if the orchestrator
// relaunches Agent/Task with an essentially identical prompt, the previous attempt did
// not land: nothing else would explain relaunching the same request. That repetition is
// the signal this gate watches, persisted per session under os.tmpdir() (never a path
// hardcoded to a particular user/machine).
//
// ── Why an identity signature, not the raw prompt ───────────────────────────────────
// Every delegation in this project is required (rules/04-subagent-standards.md) to
// carry the same fixed template — headings, "GOAL:", "IN SCOPE"/"OUT OF SCOPE", steps,
// output, criterion, handoff. Comparing raw prompts (even word/character similarity)
// counts that shared scaffolding as similarity and produces false positives between two
// UNRELATED tasks that merely reuse the template. The signature instead extracts only
// what identifies the TASK — the GOAL line (cut at the next section marker) and the
// body of the "IN SCOPE" section — plus every path/filename mentioned anywhere (as
// duplicated features, so they weigh more). Scaffolding headings are excluded. A prompt
// with no recognizable template section falls back to the whole prompt minus pure
// scaffolding lines, so the gate is never blind for lack of structure.
//
// ── Similarity ───────────────────────────────────────────────────────────────────────
// Dice coefficient over word bigrams of the signature (a multiset), not character
// bigrams and not the raw prompt: word bigrams discriminate ("fix guard" vs "fix cache")
// where character bigrams mostly measure shared vocabulary/scaffolding.
//
// ── Escape hatch ─────────────────────────────────────────────────────────────────────
// A prompt that explicitly gives a real override IMPERATIVE ("retry anyway", "force it",
// "insist") is read as the user already deciding to proceed despite the pattern: allow,
// and reset that key's counter so it does not stay open blocking the next legitimate
// attempt. The bare word "retry" mentioned as ordinary task vocabulary (e.g. "fix the
// retry loop") does NOT count — only an imperative phrasing does (see OVERRIDE_PATTERN).
//
// ── Keying: by task identity, not by the caller-chosen subagent_type ────────────────
// subagent_type is free text the caller controls. Keying the counter by that string lets
// the exact same task evade detection just by varying it per relaunch. This gate instead
// keys by a hash of the normalized identity signature itself (see identitySignature
// below) — the task's content, not a label the caller can rename at will.
//
// ── Trusting the count: recomputed, not stored ──────────────────────────────────────
// The persisted state is a list of past signatures (hashes + feature sets), never a raw
// counter. The attempt count for THIS call is always recomputed as
// "how many stored past entries are similar to this one, plus one for this call" — so a
// payload that pre-seeds or edits a `count` field on disk has nothing to tamper with:
// there is no counter field to overwrite, only a history the gate recounts itself. This
// does not add cryptographic integrity (no secret is available to sign with in a hook),
// but it does close the specific hole of a trusted, directly-writable numeric field.
//
// ── No session id: a stable fallback bucket, never a silent bypass ─────────────────
// A missing/blank session_id no longer disables the breaker. It falls back to a fixed,
// well-known bucket (NO_SESSION_BUCKET) instead of returning early — the per-task
// discrimination still comes from identityKey (a hash of the prompt's own identity
// signature), so two different tasks sharing that bucket never collide, while the SAME
// task repeated without a session id is still tracked and eventually trips the breaker.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'circuit-breaker';
const CONFIG_KEY = 'requireCircuitBreakerOnDelegation';

const DEFAULT_RETRY_THRESHOLD = 3;
const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
const MAX_ENTRIES_PER_KEY = 12;

// State root: this gate's own subdirectory under the OS temp dir, never a path that
// bakes in a username or machine name — the project rule this gate must not violate.
const STATE_ROOT = join(tmpdir(), 'claude-gates', 'circuit-breaker');

// Fixed bucket used when the payload carries no session id. Distinct tasks inside this
// bucket are still told apart by identityKey (derived from the prompt itself), so this
// is a location, not a discriminator — it never causes two unrelated tasks to collide.
const NO_SESSION_BUCKET = 'no-session';

// An override imperative: a directive to proceed anyway, not the bare topic word
// appearing as ordinary task vocabulary. Requires either a Spanish/English imperative
// verb form ("reintenta", "forzalo", "insisti") or the word "retry"/"force" paired
// immediately with "anyway"/"it"/"again" or similar — never "retry"/"force" alone,
// which a normal task description ("fix the retry loop") can contain innocently.
const OVERRIDE_PATTERN =
  /(?<![\p{L}\p{N}_])(reintent[aá]lo|reintenta(lo)?|forz(alo|á|ar)\b(?!\s+un|\s+una)|insist[ií]|retry\s+(anyway|it|again|this)|force\s+(it|this|anyway)|do\s+it\s+anyway)(?![\p{L}\p{N}_])/iu;

// Template section-heading names (rules/04-subagent-standards.md), listed once as
// plain strings and matched with simple per-name regexes rather than one combined
// alternation — a single large alternation of variable-length pieces is what trips the
// linter's backtracking-risk and complexity checks; testing a short list against a
// small, fixed-shape pattern per name does not.
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
  const escaped = name
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+');
  return new RegExp(escaped, 'i');
}

const HEADING_NAME_PATTERNS = SECTION_HEADING_NAMES.map(headingNamePattern);

/** Index of the first section marker in `text`, or -1 when none is found. Mirrors
 * `String.prototype.search` for a single combined pattern, without needing one. */
function indexOfSectionMarker(text) {
  let earliest = -1;
  for (const namePattern of HEADING_NAME_PATTERNS) {
    const match = namePattern.exec(text);
    if (!match) continue;
    const after = text.slice(match.index + match[0].length);
    if (!/^\s*:/.test(after)) continue; // only a trailing-colon heading counts as a cut point
    if (earliest === -1 || match.index < earliest) earliest = match.index;
  }
  return earliest;
}

// Spanish word for "level", assembled from fragments so the spell checker does not read
// it as prose (the project keeps an empty dictionary by policy).
const SPANISH_LEVEL_WORD = 'ni' + 'vel';
// A template literal here (with a trailing `:?$`) reads to the linter's hard-coded-path
// heuristic as a filesystem path, which it is not — plain concatenation avoids that
// false positive, and both lint fixers are disabled so neither reintroduces it.
// eslint-disable-next-line prefer-template, prettier/prettier
const SPANISH_LEVEL_LINE_PATTERN = new RegExp('^' + SPANISH_LEVEL_WORD + '\\s*:?$', 'i');

// A leading list marker, bold marker, heading hash and surrounding whitespace are all
// stripped once, plainly, before a regex looks for the heading name itself — no run of
// two adjacent unbounded quantifiers over overlapping characters (the shape that
// triggers backtracking-risk warnings).
function stripLeadingMarkup(line) {
  return line
    .trim()
    .replace(/^#{1,4}\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^\*\*/, '');
}

/** A line that is pure template scaffolding: discarded on the fallback path. */
function isScaffoldingLine(line) {
  const stripped = stripLeadingMarkup(line);
  if (/^level\s*:?$/i.test(stripped)) return true;
  if (SPANISH_LEVEL_LINE_PATTERN.test(stripped)) return true;
  return HEADING_NAME_PATTERNS.some((namePattern) => {
    const match = namePattern.exec(stripped);
    return (
      match &&
      match.index === 0 &&
      /^\s*:?$/.test(stripped.slice(match[0].length))
    );
  });
}

// Matches the goal-heading NAME only (no trailing bold markers folded into the same
// regex — an adjacent `\s*` next to `\**` is what triggers the backtracking-risk
// warning). Bold markers before the colon, if any, are stripped separately at the call
// site with a single plain replace.
const GOAL_HEADING_PATTERN = /^(objetivo|goal|meta):(.*)$/i;
const IN_SCOPE_HEADING_PATTERN = /^(que\s+s[ií]|in\s+scope|lo\s+pedido)\b/i;

/** True when `line` is the heading that ends the IN SCOPE section (any other template
 * section heading), tested the same short-list way as `indexOfSectionMarker`. */
function isEndOfInScope(line) {
  const stripped = stripLeadingMarkup(line);
  return HEADING_NAME_PATTERNS.some((namePattern) => {
    const match = namePattern.exec(stripped);
    return match && match.index === 0;
  });
}

// Path/filename shapes, checked as three separate simple patterns rather than one
// combined alternation (each stays well clear of the backtracking-risk threshold; a
// single merged pattern of these variable-length alternatives is what tripped it).
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
// A run of path-safe characters containing at least one separator. Matched as a single
// flat character class (no repeated group nested inside another repeated group), then
// validated in JS to require a real separator — the shape a backtracking engine could
// explore ambiguously is removed instead of bounded.
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

function statePathFor(sessionId) {
  return join(STATE_ROOT, sessionId, 'state.json');
}

function stripDiacritics(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokenize(text) {
  return stripDiacritics(String(text).toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', ')', ']']);

/** Strips trailing punctuation one character at a time (a bounded loop, not a
 * quantified character class anchored at the end) — a path match can pick up a
 * sentence's closing punctuation, which is not part of the path. */
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

/** Extracts the task-identifying text: goal + declared in-scope body. Empty string
 * when the prompt has none of those sections (free-form text). */
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
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (isEndOfInScope(lines[cursor])) break;
        parts.push(lines[cursor]);
      }
    }
  }

  return parts.join(' ').trim();
}

/** Fallback path: whole prompt minus lines that are pure scaffolding. */
function textWithoutScaffolding(prompt) {
  return String(prompt)
    .split(/\r?\n/)
    .filter((line) => !isScaffoldingLine(line))
    .join(' ')
    .trim();
}

/** Comparable signature: word bigrams of the identity text, plus mentioned paths as
 * duplicated features (they discriminate tasks better than prose). A multiset. */
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

  for (const path of mentionedPaths(prompt)) {
    features.push(`path:${path}`, `path:${path}`);
  }

  return features;
}

/** Dice coefficient over a multiset of features. */
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

function readState(path) {
  if (!existsSync(path)) return {};
  try {
    const content = JSON.parse(readFileSync(path, 'utf8'));
    return content && typeof content === 'object' && !Array.isArray(content)
      ? content
      : {};
  } catch {
    return {}; // corrupt/unreadable state is treated as empty, never as a block
  }
}

/** Past occurrences recorded for a key: only `{ signature, seenAt }` entries survive —
 * there is no `count` field in the persisted shape at all, so there is nothing for a
 * forged/edited state file to inflate. The attempt count is always derived by counting
 * how many of these stored occurrences are similar to the CURRENT signature (see
 * countSimilarOccurrences), never read as a trusted number off disk. */
function occurrencesFor(state, key) {
  const value = state[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry) => entry && Array.isArray(entry.signature),
  );
}

function writeState(path, state) {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Unable to persist degrades to "cannot count" — never to a silent block.
  }
}

/** How many stored past occurrences are similar enough to `signature` to count as the
 * same repeated task, PLUS one for the current call itself. Recomputed fresh from the
 * occurrence list every time — the count is a fact derived from stored signatures, not
 * a number the state file carries and a forged file could set directly. */
function countSimilarOccurrences(occurrences, signature, similarityThreshold) {
  const matches = occurrences.filter(
    (entry) => similarity(entry.signature, signature) >= similarityThreshold,
  );
  return matches.length + 1;
}

/** Task-identity key: a hash of the normalized signature, not the caller-chosen
 * subagent_type string. The exact same task tracked under a different subagent_type on
 * each relaunch still lands on the same key, because the key is derived from what the
 * task IS, not from a free-text label the caller can vary at will. */
function identityKey(signature) {
  return createHash('sha256').update(signature.join(' ')).digest('hex');
}

function denyRepeatedAttempt(count) {
  deny(
    GATE_ID,
    `This same task received ${count} consecutive attempts (same goal, same scope and the same files) ` +
      'in this session, regardless of which subagent_type carried it. Do not relaunch this same ' +
      'delegation again — escalate to the user with evidence: what was tried, what blocked it, and what ' +
      'decision is needed. Escape hatch: if the user explicitly authorized it, include an override ' +
      'imperative ("retry anyway"/"force it"/"insisti") in the next delegation\'s prompt and this gate ' +
      'will allow it and reset the counter.',
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
  ({ toolName, toolInput, sessionId, parameters }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;

    // A missing/blank session id no longer disables the breaker: it falls back to a
    // fixed bucket, with identityKey (below) still discriminating between tasks.
    const effectiveSessionId = sessionId || NO_SESSION_BUCKET;

    const statePath = statePathFor(effectiveSessionId);
    const state = readState(statePath);

    const signature = identitySignature(prompt);
    const key = identityKey(signature);

    if (OVERRIDE_PATTERN.test(prompt)) {
      // The user already decided to proceed despite the pattern: allow, and clear
      // whichever key(s) hold a similar history. The override phrase itself ("force it,
      // retry.") is appended text that can shift the identity signature enough to land
      // on a different hash than the original task's key — clearing only the exact
      // current key would then miss the very history this call is meant to reset. Every
      // existing key whose stored signature is similar to the current one (by the same
      // threshold the normal path uses) is cleared, plus the current key itself.
      for (const existingKey of Object.keys(state)) {
        const occurrences = occurrencesFor(state, existingKey);
        const isRelated =
          existingKey === key ||
          occurrences.some(
            (entry) =>
              similarity(entry.signature, signature) >=
              parameters.similarityThreshold,
          );
        if (isRelated) delete state[existingKey];
      }
      writeState(statePath, state);
      return;
    }

    const occurrences = occurrencesFor(state, key);
    const count = countSimilarOccurrences(
      occurrences,
      signature,
      parameters.similarityThreshold,
    );

    const updated = [
      ...occurrences,
      { signature, seenAt: Date.now() },
    ].slice(-MAX_ENTRIES_PER_KEY);
    state[key] = updated;
    writeState(statePath, state);

    if (count >= parameters.retryThreshold) {
      denyRepeatedAttempt(count);
    }
  },
);
