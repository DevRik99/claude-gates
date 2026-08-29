// no-memory-dependency — warns (never denies) when a delegation prompt leans on the
// subagent "remembering" something said earlier in conversation instead of carrying
// the data itself. A fresh subagent has no access to the delegator's conversation
// history: if the data matters, it must travel IN the prompt, in a file the subagent
// reads, or in an already-persisted decision.
//
// ── Two stages, same pattern as intent-flow ─────────────────────────────────────────
// Stage 1 (cheap): does any memory-dependency phrase appear anywhere? If not, allow.
// Stage 2 (confirmation, only on candidates): strip quoted text, then discard a phrase
// that has a deterministic persistence instruction nearby (a file, flag, env var, gate)
// — "remember to save this to notes.md" does not depend on model memory, it depends on
// a real file. This is a soft signal (warn), not a hard block: whether the brief truly
// needs the data or is just referencing prior agreement needs judgment this gate can't
// supply on its own.

import { runGate, warn, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'no-memory-dependency';
const CONFIG_KEY = 'warnMemoryDependencyInBrief';

const DELEGATION_TOOLS = new Set(TOOL_GROUPS.delegation);

const DEFAULT_MEMORY_DEPENDENCY_PATTERNS = [
  'acordate de|acu[eé]rdate de',
  'no olvides|no te olvides',
  'record[aá] que|ten[eé] en cuenta que',
  'como te dije|como ya te dije|ya te dije|te lo dije antes|ya te ped[ií]',
  "remember to|don'?t forget|keep in mind",
];

// Split into two simpler alternations (tested with plain OR at call time) instead of
// one large regex: each half stays well under the complexity/backtracking budget a
// single combined pattern would hit.
const PERSISTENCE_NOUN_PATTERN =
  /archivo|file|flag|variable de entorno|env var|gate determinista|deterministic gate|\.md|\.json/i;
// Kept deliberately flat (no nested optional groups) to stay under the regex-complexity
// budget: a handful of plain alternatives rather than one clever pattern with backtracking.
const PERSISTENCE_VERB_PATTERN =
  /guardal[oa]|guarda|guardá esto|persisti|persiste|persistir|persistido|escribil[oa] en|escribi en|save it in|save this in|save it to|save this to/i;

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

function hasPersistenceInstructionNearby(text, match) {
  const from = Math.max(0, match.index - PERSISTENCE_WINDOW);
  const to = Math.min(
    text.length,
    match.index + match[0].length + PERSISTENCE_WINDOW,
  );
  const window = text.slice(from, to);
  return (
    PERSISTENCE_NOUN_PATTERN.test(window) ||
    PERSISTENCE_VERB_PATTERN.test(window)
  );
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
    if (!DELEGATION_TOOLS.has(toolName)) return;

    const prompt = String(
      toolInput.prompt ?? toolInput.description ?? toolInput.task ?? '',
    );
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
