// brief-before-delegate — denies an implementation delegation whose prompt does not state a
// GOAL, concrete STEPS and a DONE-WHEN criterion, each with real content past its marker.
//
// Decisions: the gate judges that the brief EXISTS, never that it is good — "is this the
// right goal" needs domain judgment a hook cannot supply. A read-only subagent name is a
// declared label, not a verified capability, so it exempts only while the prompt carries no
// mutation-risk signal. A documentary deliverable (README, report, changelog) is not an
// implementation brief and is not judged here.

import {
  DEFAULT_READ_ONLY_SUBAGENTS,
  isDocumentaryRequest,
  isExemptQuery,
  isImplementationRequest,
  isReadOnlySubagent,
  promptExcerpt,
} from '../../lib/delegation.mjs';
import {
  runGate,
  deny,
  warn,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { withUnicodeWordBoundary } from '../../lib/signals.mjs';

const GATE_ID = 'brief-before-delegate';
const CONFIG_KEY = 'requireBriefBeforeDelegating';

const DEFAULT_MIN_BRIEF_LENGTH = 180;

// All three signals missing at once is indistinguishable from "never thought through", so
// that combination denies where a partial brief only warns.
const TOTAL_REQUIRED_SIGNALS = 3;
// A single filler word ("cosa.", "listo.") must not clear the bar; any real sentence does.
const MIN_SECTION_SUBSTANCE_LENGTH = 12;
const MIN_SUBSTANTIVE_WORDS = 2;
const MIN_WORD_LENGTH = 3;

const GOAL_PATTERN = withUnicodeWordBoundary(
  'objetivo|meta|el fin es|se busca|para lograr|para que|goal|objective',
);

// Anchored per line with a single bounded `\s*` so a backtracking engine has nothing to
// explode on; global so every item's substance can be checked.
const STRUCTURED_STEPS_PATTERN = /^[ \t]*(?:[-*•]|\d+[.)])[ \t]+(\S.*)$/gm;

const CRITERION_PATTERN = withUnicodeWordBoundary(
  'criterio|acceptance|asserts?|se considera (hecho|terminado|listo)|' +
    'debe (verificarse|cumplir|pasar)|hasta que|done.when|' +
    'cuando (esto|el) (pase|funcione)|dado.{0,20}cuando.{0,20}entonces|' +
    'given.{0,20}when.{0,20}then',
);

// Real words that say nothing concrete, so "listo cuando funcione bien y quede resuelto
// satisfactoriamente para todos" does not read as substance.
const FILLER_WORDS = new Set(
  (
    'cosa cosas cualquier corresponda correspondiente relevante sistema bien listo ' +
    'cuando funcione quede resuelto satisfactoriamente para todos segun paso arreglo ' +
    'anything something whatever appropriate accordingly relevant properly done ' +
    'the a an and or of to in on for with is are'
  ).split(' '),
);

function stripDiacritics(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

function substantiveWordCount(text) {
  const words = stripDiacritics(String(text).toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.filter(
    (word) => word.length >= MIN_WORD_LENGTH && !FILLER_WORDS.has(word),
  ).length;
}

function contentAfterMarker(prompt, markerMatch) {
  const from = markerMatch.index + markerMatch[0].length;
  const restOfLine = prompt.slice(from).split(/\r?\n/, 1)[0] ?? '';
  return restOfLine.replace(/^[\s:.\-–—]+/, '');
}

function hasSubstance(content) {
  return (
    content.trim().length >= MIN_SECTION_SUBSTANCE_LENGTH &&
    substantiveWordCount(content) >= MIN_SUBSTANTIVE_WORDS
  );
}

function markerHasSubstance(prompt, pattern) {
  const withGlobal = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of prompt.matchAll(withGlobal)) {
    if (hasSubstance(contentAfterMarker(prompt, match))) return true;
  }
  return false;
}

function stepsHaveSubstance(prompt) {
  return [...prompt.matchAll(STRUCTURED_STEPS_PATTERN)].some(
    (match) => substantiveWordCount(match[1]) >= MIN_SUBSTANTIVE_WORDS,
  );
}

function missingSignals(prompt) {
  const missing = [];
  if (!markerHasSubstance(prompt, GOAL_PATTERN))
    missing.push(
      'a stated GOAL with real content (what this aims to achieve, not just the word "goal")',
    );
  if (!stepsHaveSubstance(prompt)) {
    missing.push(
      'STEPS as a list or numbered form with concrete files/actions, not a placeholder item',
    );
  }
  if (!markerHasSubstance(prompt, CRITERION_PATTERN)) {
    missing.push(
      'a DONE-WHEN / acceptance criterion with real content (how completion is verified, not just the word "criterion")',
    );
  }
  return missing;
}

function denyTooShort(prompt, minBriefLength) {
  deny(
    CONFIG_KEY,
    `This delegation asks for implementation ("${promptExcerpt(prompt)}") in a ${prompt.length}-character ` +
      `prompt — too short to carry a goal, steps and a done-when criterion (minBriefLength: ${minBriefLength}). ` +
      'State what this aims to achieve, what concretely needs doing (as a list or steps), and how ' +
      'completion is verified, then relaunch.',
  );
}

function reportMissingSignals(missing) {
  if (missing.length === 0) return;

  if (missing.length < TOTAL_REQUIRED_SIGNALS) {
    warn(
      CONFIG_KEY,
      `This implementation delegation does not recognizably state: ${missing.join('; ')}. ` +
        'If it is already there under different wording, proceed — this is only a warning. ' +
        'Otherwise add it before the subagent starts blind.',
    );
    return;
  }

  deny(
    CONFIG_KEY,
    'This delegation asks for implementation but states neither as a list nor recognizable prose: ' +
      `${missing.join('; ')}. Add to the prompt: (1) the GOAL — what this aims to achieve; ` +
      '(2) the STEPS — concrete files/actions, as a list; (3) the CRITERION — how completion is ' +
      'verified. The form is free; the content is not optional.',
  );
}

function isExempt(toolInput, prompt, readOnlySubagents) {
  if (!prompt.trim()) return true;
  if (isReadOnlySubagent(toolInput, prompt, readOnlySubagents)) return true;
  if (isExemptQuery(prompt)) return true;
  if (!isImplementationRequest(prompt)) return true;
  return isDocumentaryRequest(prompt);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      minBriefLength: DEFAULT_MIN_BRIEF_LENGTH,
      readOnlySubagents: DEFAULT_READ_ONLY_SUBAGENTS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (isExempt(toolInput, prompt, parameters.readOnlySubagents)) return;

    const trimmed = prompt.trim();
    if (trimmed.length < parameters.minBriefLength) {
      denyTooShort(trimmed, parameters.minBriefLength);
    }

    reportMissingSignals(missingSignals(prompt));
  },
);
