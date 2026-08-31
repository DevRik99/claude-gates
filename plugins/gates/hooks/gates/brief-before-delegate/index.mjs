// brief-before-delegate — denies an implementation delegation whose prompt does not
// declare, in recognizable form, a GOAL, concrete STEPS and a DONE-WHEN criterion.
//
// ── Why this is decidable, and what it deliberately does not judge ─────────────────
// A hook sees a tool call, not how hard the underlying task is. "Complex" is not a
// fact in the payload, and any heuristic that approximates it (file count, prompt
// length, "architecture" keywords) ends up blocking trivial work sooner or later.
// The decidable question is narrower: did THIS delegation's prompt state a goal, its
// steps and a success criterion before the subagent starts? That is a fact about the
// text itself, not a judgment about the task.
//
// Whether the declared goal is the RIGHT goal, or the steps are the RIGHT steps, or
// the criterion truly resolves the ambiguity — that needs domain understanding a
// script cannot supply. This gate only enforces that the brief EXISTS, never that it
// is good. It DOES require each section to carry actual content past its marker —
// pasting the words "Objetivo:"/"Criterio:" next to filler is not a brief either.
//
// ── What is exempt ───────────────────────────────────────────────────────────────
// - Read-only exploration/subagents (readOnlySubagents param, or a prompt whose
//   dominant verb is investigate/search/read/explain/audit with no implementation
//   verb): that is a QUESTION, not an implementation order — forcing a brief onto it
//   would make it simulate project structure it does not have.
//   The readOnlySubagents exemption is a name the delegator declares, not a verified
//   capability this hook can check — so it is void whenever the prompt itself carries
//   a mutation-risk signal (money/auth/data/write/deploy): the signal in the text
//   outranks the label on the call.
// - A prompt that already carries structure (a list, numbered steps, or prose that
//   otherwise states the three signals): the form is free, only the content is
//   required.

import {
  runGate,
  deny,
  warn,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { MUTATION_RISK_SIGNAL } from '../../lib/signals.mjs';

const GATE_ID = 'brief-before-delegate';
const CONFIG_KEY = 'requireBriefBeforeDelegating';

const DEFAULT_MIN_BRIEF_LENGTH = 180;
const DEFAULT_READ_ONLY_SUBAGENTS = ['explore', 'claude-code-guide', 'plan'];

// How much of an over-length prompt to quote back in a denial message.
const PROMPT_EXCERPT_LENGTH = 80;
// Total signals this gate checks for (goal, steps, criterion): when all are missing at
// once it is indistinguishable from "never thought through", so that combination denies
// instead of only warning.
const TOTAL_REQUIRED_SIGNALS = 3;
// Minimum substantial (non-stopword) characters a section needs past its own marker to
// count as "stated" instead of merely name-dropped. Chosen so a single short filler
// word ("cosa.", "listo.") does not clear it, but any real sentence does.
const MIN_SECTION_SUBSTANCE_LENGTH = 12;

/** Unicode-aware word boundary: JS's `\b` does not treat accented letters as word
 * chars, so a plain `\bcorregi\b`-style pattern silently misses an accented
 * imperative. Lookarounds over `\p{L}|\p{N}|_` cover the full alphabet instead. */
function withUnicodeWordBoundary(alternatives) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(${alternatives})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

const IMPLEMENTATION_VERBS = withUnicodeWordBoundary(
  'implementa|implementar|escrib(e|í)|escribir|cre(a|á)|crear|corrige|correg(í|ir)|' +
    'arregl(a|á)|arreglar|constru(ye|í)|construir|refactoriz(a|á)|refactorizar|' +
    'migr(a|á)|migrar|agreg(a|á)|agregar|añad(e|í)|añadir|elimin(a|á)|eliminar|' +
    'modific(a|á)|modificar|reescrib(e|í)|reescribir|desplieg(a|á)|desplegar|' +
    'hac(e|er|é)|resuelve|resolv(é|er)|soluciona|solucion(á|ar)|encárgate|encargate|' +
    'ocúpate|ocupate|cambi(a|á)|cambiar|actualiz(a|á)|actualizar|' +
    'implement|write|fix|build|refactor|migrate|add|remove|modify|update',
);

const READ_ONLY_VERBS = withUnicodeWordBoundary(
  'investiga|investigar|busca|buscar|explora|explorar|lee|leer|explica|explicar|' +
    'audita|auditar|analiza|analizar|compara|comparar|diagnostica|diagnosticar|' +
    'revisa|revisar|averigua|averiguar|' +
    'investigate|search|explore|read|explain|audit|analyze|compare|diagnose|review',
);

// A prompt-level signal that a whitelisted read-only subagent name should NOT be
// trusted to exempt this call: real mutation risk in the text outranks a self-declared
// label. Deliberately broad (over-includes) — a false positive here only means the
// brief check still runs, which is cheap; a false negative would let a mutator hide.
// Centralized in lib/signals.mjs (ES+EN) — see its header for the class this covers.
const MUTATION_RISK_SIGNAL_PATTERN = MUTATION_RISK_SIGNAL;

/** Evidence of a stated GOAL, captured so its trailing content can be measured. */
const GOAL_PATTERN = withUnicodeWordBoundary(
  'objetivo|meta|el fin es|se busca|para lograr|para que|goal|objective',
);

/** Evidence of structured STEPS: a list/bullet/numbered form. Anchored per-line (`m`
 * flag) with a single bounded `\s*` after the line start, so there is no nested
 * quantifier for a backtracking engine to explode on. Global so every item's substance
 * can be checked, not just the first. */
const STRUCTURED_STEPS_PATTERN = /^[ \t]*(?:[-*•]|\d+[.)])[ \t]+(\S.*)$/gm;

/** Evidence of a DONE-WHEN / acceptance criterion. */
const CRITERION_PATTERN = withUnicodeWordBoundary(
  'criterio|acceptance|asserts?|se considera (hecho|terminado|listo)|' +
    'debe (verificarse|cumplir|pasar)|hasta que|done.when|' +
    'cuando (esto|el) (pase|funcione)|dado.{0,20}cuando.{0,20}entonces|' +
    'given.{0,20}when.{0,20}then',
);

// Filler words that do not count toward a section's substance even though they are
// real words — otherwise "listo cuando funcione bien y quede resuelto satisfactoriamente
// para todos" reads as substantial despite saying nothing concrete.
const FILLER_WORDS = new Set(
  (
    'cosa cosas cualquier corresponda correspondiente relevante sistema bien listo ' +
    'cuando funcione quede resuelto satisfactoriamente para todos segun paso arreglo ' +
    'anything something whatever appropriate accordingly relevant properly done ' +
    'the a an and or of to in on for with is are'
  ).split(' '),
);

function stripDiacritics(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Non-filler word count in a chunk of text: what is left after dropping stopwords and
 * pure-filler vocabulary, so a marker followed only by empty phrasing does not count as
 * substance. */
function substantiveWordCount(text) {
  const words = stripDiacritics(String(text).toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.filter((word) => word.length > 2 && !FILLER_WORDS.has(word))
    .length;
}

/** Text following a marker match, cut at end-of-line, so a following unrelated section
 * on the next line is not counted as this section's content. */
function contentAfterMarker(prompt, markerMatch) {
  const from = markerMatch.index + markerMatch[0].length;
  const restOfLine = prompt.slice(from).split(/\r?\n/, 1)[0] ?? '';
  return restOfLine.replace(/^[\s:.\-–—]+/, '');
}

/** Whether the GOAL or CRITERION marker is followed by real substance: enough
 * substantive words, not just the marker itself or generic filler around it. */
function markerHasSubstance(prompt, pattern) {
  const withGlobal = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  const match = withGlobal.exec(prompt);
  if (!match) return false;
  const content = contentAfterMarker(prompt, match);
  return (
    content.trim().length >= MIN_SECTION_SUBSTANCE_LENGTH &&
    substantiveWordCount(content) >= 2
  );
}

/** Whether at least one structured list item carries real substance (not just a single
 * filler word like "paso"). */
function stepsHaveSubstance(prompt) {
  const matches = [...prompt.matchAll(STRUCTURED_STEPS_PATTERN)];
  return matches.some((match) => substantiveWordCount(match[1]) >= 2);
}

function isReadOnlySubagentName(toolInput, readOnlySubagents) {
  const type = String(
    toolInput.subagent_type ?? toolInput.subagentType ?? '',
  ).toLowerCase();
  return new Set(readOnlySubagents.map((name) => name.toLowerCase())).has(type);
}

/** A whitelisted subagent name exempts a call ONLY when the prompt carries no
 * mutation-risk signal. The name is a declared label, never a verified capability this
 * hook can check — documented here so a future reader does not mistake it for one — and
 * a real risk signal in the text must win over it. */
function isReadOnlySubagent(toolInput, prompt, readOnlySubagents) {
  if (!isReadOnlySubagentName(toolInput, readOnlySubagents)) return false;
  return !MUTATION_RISK_SIGNAL_PATTERN.test(prompt);
}

function isReadOnlyRequest(prompt) {
  if (IMPLEMENTATION_VERBS.test(prompt)) return false;
  return READ_ONLY_VERBS.test(prompt);
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

function denyTooShort(prompt) {
  const excerpt = prompt.slice(0, PROMPT_EXCERPT_LENGTH);
  const ellipsis = prompt.length > PROMPT_EXCERPT_LENGTH ? '…' : '';
  deny(
    GATE_ID,
    `This delegation asks for implementation ("${excerpt}${ellipsis}") in a ${prompt.length}-character ` +
      'prompt — too short to carry a goal, steps and a done-when criterion. State what this aims to ' +
      'achieve, what concretely needs doing (as a list or steps), and how completion is verified, then ' +
      'relaunch.',
  );
}

function reportMissingSignals(missing) {
  if (missing.length === 0) return;

  if (missing.length < TOTAL_REQUIRED_SIGNALS) {
    warn(
      GATE_ID,
      `This implementation delegation does not recognizably state: ${missing.join('; ')}. ` +
        'If it is already there under different wording, proceed — this is only a warning. ' +
        'Otherwise add it before the subagent starts blind.',
    );
    return;
  }

  deny(
    GATE_ID,
    'This delegation asks for implementation but states neither as a list nor recognizable prose: ' +
      `${missing.join('; ')}. Add to the prompt: (1) the GOAL — what this aims to achieve; ` +
      '(2) the STEPS — concrete files/actions, as a list; (3) the CRITERION — how completion is ' +
      'verified. The form is free; the content is not optional.',
  );
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
    if (!prompt.trim()) return;
    if (isReadOnlySubagent(toolInput, prompt, parameters.readOnlySubagents))
      return;
    if (isReadOnlyRequest(prompt)) return;
    if (!IMPLEMENTATION_VERBS.test(prompt)) return; // neither implementation nor read-only: do not guess

    const trimmed = prompt.trim();
    if (trimmed.length < parameters.minBriefLength) {
      denyTooShort(trimmed);
    }

    reportMissingSignals(missingSignals(prompt));
  },
);
