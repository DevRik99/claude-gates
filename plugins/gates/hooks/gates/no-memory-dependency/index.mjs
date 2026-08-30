// no-memory-dependency — warns (never denies) when a delegation prompt leans on the
// subagent "remembering" something said earlier in conversation instead of carrying
// the data itself. A fresh subagent has no access to the delegator's conversation
// history: if the data matters, it must travel IN the prompt, in a file the subagent
// reads, or in an already-persisted decision.
//
// ── Two stages, same pattern as intent-flow ─────────────────────────────────────────
// Stage 1 (cheap): does any memory-dependency phrase appear anywhere? If not, allow.
// Stage 2 (confirmation, only on candidates): strip quoted text, then discard a phrase
// that has a REAL deterministic persistence INSTRUCTION nearby (not just a noun/verb
// mentioned in passing) — "no te olvides de guardar la decision en .ai/decision.md"
// genuinely depends on a file, not on model memory. A persistence noun/verb that merely
// co-occurs in the window without forming an instruction TO persist THIS remembered
// thing (e.g. an unrelated file named elsewhere in the same sentence) does not suppress
// the warning. This stays a soft signal (warn), never a hard block: whether the brief
// truly needs the data or is just referencing prior agreement needs judgment this gate
// can't supply on its own.

import {
  runGate,
  warn,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'no-memory-dependency';
const CONFIG_KEY = 'warnMemoryDependencyInBrief';

const DEFAULT_MEMORY_DEPENDENCY_PATTERNS = [
  'acordate de|acu[eé]rdate de',
  'no olvides|no te olvides',
  'record[aá] que|ten[eé] en cuenta que',
  'como te dije|como ya te dije|ya te dije|te lo dije antes|ya te ped[ií]',
  "remember to|don'?t forget|keep in mind",
];

// A real persistence INSTRUCTION requires an imperative persistence VERB (an actual
// directive to save/persist/write THIS remembered thing), not merely a persistence-
// related NOUN mentioned somewhere nearby (a stray "incident.md" in the same sentence
// names a file without instructing anything be saved to it). The noun pattern is kept
// only to require the verb's own target look like a real destination (file/flag/env
// var/gate), so a bare "guarda" with no destination in view still counts (it is already
// imperative), but a bare destination noun with no verb never does.
// Kept deliberately flat (no nested optional groups) to stay under the regex-complexity
// budget: a handful of plain alternatives rather than one clever pattern with backtracking.
const PERSISTENCE_VERB_PATTERN =
  /guardal[oa]|guarda(l[oa])?|guardá esto|persisti|persiste|persistir|persistido|escribil[oa] en|escribi en|save it in|save this in|save it to|save this to/i;

const PERSISTENCE_WINDOW = 80;

function withUnicodeWordBoundary(alternatives) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(${alternatives})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

function stripQuoted(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/"[^"\n]{0,300}"/g, ' ')
    .replace(/'[^'\n]{0,300}'/g, ' ');
}

function allMatches(pattern, text) {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))];
}

/** True only when the window around a memory phrase carries a real persistence
 * INSTRUCTION — an imperative persistence verb — not merely a persistence-related noun
 * mentioned in passing. A noun alone ("el reporte esta en incident.md") names a file
 * without instructing anything be saved to it, so it must NOT suppress the warning. */
function hasPersistenceInstructionNearby(text, match) {
  const from = Math.max(0, match.index - PERSISTENCE_WINDOW);
  const to = Math.min(
    text.length,
    match.index + match[0].length + PERSISTENCE_WINDOW,
  );
  const window = text.slice(from, to);
  return PERSISTENCE_VERB_PATTERN.test(window);
}

function unresolvedMemoryPhrases(prompt, memoryPattern) {
  if (!memoryPattern.test(prompt)) return []; // stage 1: no candidate, allow cheap

  const text = stripQuoted(prompt); // stage 2(a)
  const matches = allMatches(memoryPattern, text);

  return matches
    .filter((match) => !hasPersistenceInstructionNearby(text, match))
    .map((match) => match[0].trim());
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      memoryDependencyPatterns: DEFAULT_MEMORY_DEPENDENCY_PATTERNS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;

    const memoryPattern = withUnicodeWordBoundary(
      (parameters.memoryDependencyPatterns ?? []).join('|'),
    );

    const phrases = unresolvedMemoryPhrases(prompt, memoryPattern);
    if (phrases.length === 0) return;

    const quotedPhrases = phrases.map((phrase) => `"${phrase}"`).join(', ');
    warn(
      GATE_ID,
      `This delegation depends on the model remembering something (${quotedPhrases}). ` +
        'If it matters, it should live in a file, a flag, an environment variable, or a deterministic gate — ' +
        "not in the model's memory.",
    );
  },
);
