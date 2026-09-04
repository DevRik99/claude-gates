// no-memory-dependency — denies a delegation whose prompt refers the subagent to something
// said earlier in the conversation ("como te dije", "as we discussed") instead of carrying
// the data itself: a fresh subagent has none of the delegator's history.
//
// Decisions: the default phrases are references to PRIOR CONVERSATION only — "don't forget
// to X", "keep in mind that <fact>", "remember to run the tests" carry their own content and
// are allowed. A reference next to a real persistence instruction ("como quedamos, guardá la
// decisión en .ai/decision.md") depends on a file, not on memory, and is allowed. The escape
// hatch marker states that no recalled data is actually needed.

import {
  allMatches,
  promptExcerpt,
  stripQuoted,
} from '../../lib/delegation.mjs';
import {
  runGate,
  deny,
  compileRegexList,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import {
  PERSISTENCE_VERB,
  withUnicodeWordBoundary,
} from '../../lib/signals.mjs';

const GATE_ID = 'no-memory-dependency';
const CONFIG_KEY = 'warnMemoryDependencyInBrief';

const DEFAULT_ESCAPE_HATCH = 'memory-not-needed';

const DEFAULT_MEMORY_DEPENDENCY_PATTERNS = [
  'recuerda que|acu[eé]rdate de (?:lo )?que|acordate de (?:lo )?que|como te dije',
  'como (vimos|hablamos|dijimos|quedamos)|lo de antes',
  'lo que te (dije|comenté|pasé)|ya sabes cu[aá]l',
  'el (archivo|cambio|tema) de antes',
  'remember that we|as (i|we) (said|discussed|mentioned|agreed)|as discussed',
  'as mentioned (earlier|before|above)|the one from (before|earlier)',
  'what we (discussed|talked about|decided)|you know which',
  'like (before|last time)|the previous (one|file|change) i mentioned',
];

const PERSISTENCE_WINDOW = 80;

function hasPersistenceInstructionNearby(text, match) {
  const from = Math.max(0, match.index - PERSISTENCE_WINDOW);
  const to = Math.min(
    text.length,
    match.index + match[0].length + PERSISTENCE_WINDOW,
  );
  return PERSISTENCE_VERB.test(text.slice(from, to));
}

function memoryPatternFrom(sources) {
  const { patterns } = compileRegexList(sources, 'iu');
  if (patterns.length === 0) return null;
  return withUnicodeWordBoundary(
    patterns.map((pattern) => `(?:${pattern.source})`).join('|'),
  );
}

function unresolvedMemoryPhrases(prompt, memoryPattern) {
  if (!memoryPattern.test(prompt)) return [];
  const text = stripQuoted(prompt);
  return allMatches(memoryPattern, text)
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
      escapeHatch: DEFAULT_ESCAPE_HATCH,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;

    const escapeHatch = String(parameters.escapeHatch ?? '').toLowerCase();
    if (escapeHatch && prompt.toLowerCase().includes(escapeHatch)) return;

    const memoryPattern = memoryPatternFrom(
      parameters.memoryDependencyPatterns,
    );
    if (!memoryPattern) return;

    const phrases = unresolvedMemoryPhrases(prompt, memoryPattern);
    if (phrases.length === 0) return;

    const quotedPhrases = phrases.map((phrase) => `"${phrase}"`).join(', ');
    deny(
      CONFIG_KEY,
      `This delegation ("${promptExcerpt(prompt)}") depends on the subagent remembering something ` +
        `(${quotedPhrases}), but a fresh subagent has none of this conversation. Put the data IN the ` +
        'prompt, in a file it reads, a flag, or an already-persisted decision. If the phrase needs no ' +
        `recalled data, add the marker "${escapeHatch || DEFAULT_ESCAPE_HATCH}" to the prompt.`,
    );
  },
);
