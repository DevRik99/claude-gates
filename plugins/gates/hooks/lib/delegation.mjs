// delegation.mjs — what every gate that judges a subagent delegation shares: who the
// subagent is, whether it is exempt, whether the prompt asks for implementation or a
// read-only query, which risk LEVEL it declares, and whether it really intends to mutate a
// high-impact area. Before this module each of eight gates carried its own copy of these,
// with eight divergent verb lists, two case-sensitivity rules for exemptions, and two
// contradictory ways to read a LEVEL.
//
// Self-contained: Node built-ins only (plus signals.mjs, this plugin's own).

import { MUTATION_RISK_SIGNAL, withUnicodeWordBoundary } from './signals.mjs';

/** Subagent types that, by declared purpose, never mutate (exempt unless the prompt says
 * otherwise — see isReadOnlySubagent). */
export const DEFAULT_READ_ONLY_SUBAGENTS = [
  'explore',
  'claude-code-guide',
  'plan',
];

/** Subagent types the spec-driven gates exempt (planning/review/QA roles). */
export const DEFAULT_EXEMPT_SUBAGENTS = [
  'explore',
  'plan',
  'scout',
  'revision',
  'contraste',
  'test-planner',
  'qa',
  'ui',
  'ux',
];

/** The subagent type a delegation names, lowercased; '' when absent. */
export function subagentTypeOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(toolInput.subagent_type ?? toolInput.subagentType ?? '')
    .trim()
    .toLowerCase();
}

/** Whether the delegation's subagent type is in `names` (case-insensitive both sides). */
export function isSubagentNamedIn(toolInput, names) {
  const type = subagentTypeOf(toolInput);
  if (!type || !Array.isArray(names)) return false;
  return names.some((name) => String(name).trim().toLowerCase() === type);
}

/**
 * A whitelisted read-only subagent name exempts a call ONLY when the prompt carries no
 * mutation-risk signal: the name is a declared label, never a verified capability a hook
 * can check, so real risk in the text outranks it.
 */
export function isReadOnlySubagent(toolInput, prompt, readOnlySubagents) {
  if (!isSubagentNamedIn(toolInput, readOnlySubagents)) return false;
  return !MUTATION_RISK_SIGNAL.test(String(prompt ?? ''));
}

// ── Verbs ───────────────────────────────────────────────────────────────────────────
// One vocabulary, Spanish (tú/vos/infinitive forms) and English, for "this delegation
// asks the subagent to CHANGE something". Broad on purpose: a miss here means a gate never
// runs (a silent hole), a false hit only means a cheap check runs.
const IMPLEMENTATION_VERB_SOURCES =
  'implementa|implementar|implement(á|é)|agreg(a|á)|agregar|añad(e|í)|añadir|cre(a|á)|crear|' +
  'arregl(a|á)|arreglar|cambi(a|á)|cambiar|migr(a|á)|migrar|escrib(í|e)|escribir|' +
  'corrige|corregir|correg(í|ir)|constru(ye|í)|construir|modific(a|á)|modificar|' +
  'refactoriz(a|á)|refactorizar|elimin(a|á)|eliminar|borr(a|á)|borrar|reescrib(e|í)|reescribir|' +
  'desplieg(a|á)|desplegar|renombr(a|á)|renombrar|edit(a|á)|editar|actualiz(a|á)|actualizar|' +
  'hac(e|er|é)|resuelve|resolv(é|er)|soluciona|solucion(á|ar)|encárgate|encargate|' +
  'ocúpate|ocupate|instal(a|á)|instalar|configur(a|á)|configurar|reemplaz(a|á)|reemplazar|' +
  'implement(?:s|ed|ing)?|writ(?:e|es|ing|ten)|creat(?:e|es|ed|ing)|fix(?:es|ed|ing)?|' +
  'build(?:s|ing)?|built|refactor(?:s|ed|ing)?|migrat(?:e|es|ed|ing)|add(?:s|ed|ing)?|' +
  'remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|modif(?:y|ies|ied|ying)|rewrit(?:e|es|ing|ten)|' +
  'deploy(?:s|ed|ing)?|updat(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|' +
  'edit(?:s|ed|ing)?|replac(?:e|es|ed|ing)|convert(?:s|ed|ing)?|install(?:s|ed|ing)?|' +
  'configur(?:e|es|ed|ing)|extend(?:s|ed|ing)?|patch(?:es|ed|ing)?|upgrad(?:e|es|ed|ing)';

export const IMPLEMENTATION_VERBS = withUnicodeWordBoundary(
  IMPLEMENTATION_VERB_SOURCES,
);

const QUERY_VERB_SOURCES =
  'explica|explic(á|ar)|qu[eé]|c[oó]mo|muestra|mostr(á|ar)|analiza|analiz(á|ar)|investiga|' +
  'investig(á|ar)|revisa|revis(á|ar)|audita|audit(á|ar)|diagnostica|diagnostic(á|ar)|' +
  'busca|buscar|explora|explorar|lee|leer|compara|comparar|averigua|averiguar|' +
  'explain|what|how|show|analy[sz]e|investigate|review|audit|diagnose|search|explore|read|compare';

export const QUERY_VERBS = withUnicodeWordBoundary(QUERY_VERB_SOURCES);

/** Whether the prompt carries an implementation (mutating) verb. */
export function isImplementationRequest(prompt) {
  return IMPLEMENTATION_VERBS.test(String(prompt ?? ''));
}

/** A query with no implementation verb at all (implementation verbs take priority). */
export function isExemptQuery(prompt) {
  const text = String(prompt ?? '');
  if (IMPLEMENTATION_VERBS.test(text)) return false;
  return QUERY_VERBS.test(text);
}

// ── Documentary deliverables ────────────────────────────────────────────────────────
const DOCUMENTARY_DELIVERABLE_PATTERN = withUnicodeWordBoundary(
  'documento|documentaci[oó]n|reporte|informe|diagrama|readme|wiki|changelog|' +
    'p[aá]gina de documentaci[oó]n|archivo html|p[aá]gina html|markdown|document|documentation|report',
);
const DOCUMENTARY_EXTENSION_PATTERN = /\.(md|mdx|html?|adoc|rst|txt)(?!\w)/iu;
const VERB_OBJECT_WINDOW = 60;

/** Whether the verb at `verbMatch` acts on a documentary deliverable (a doc describing an
 * area is not mutating that area). */
export function verbProducesDocument(text, verbMatch) {
  const from = verbMatch.index;
  const objectOfVerb = text.slice(
    from,
    from + verbMatch[0].length + VERB_OBJECT_WINDOW,
  );
  return (
    DOCUMENTARY_DELIVERABLE_PATTERN.test(objectOfVerb) ||
    DOCUMENTARY_EXTENSION_PATTERN.test(objectOfVerb)
  );
}

/** Whether the prompt as a whole asks for a document rather than a code change. */
export function isDocumentaryRequest(prompt) {
  const text = String(prompt ?? '');
  const verbs = allMatches(IMPLEMENTATION_VERBS, text);
  if (verbs.length === 0) return false;
  return verbs.every((verb) => verbProducesDocument(text, verb));
}

// ── Text helpers ────────────────────────────────────────────────────────────────────
const MAX_QUOTED_LENGTH = 300;

/**
 * Removes fenced code blocks and double-quoted strings (up to 300 chars) so quoted or
 * templated text is not mistaken for the prompt's own intent. Single quotes are NOT
 * stripped: in English prose they are apostrophes (don't, user's), and stripping between
 * them erased arbitrary spans of the real prompt.
 */
export function stripQuoted(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(new RegExp(`"[^"\\n]{0,${MAX_QUOTED_LENGTH}}"`, 'g'), ' ');
}

/** Every match of `pattern` in `text` (a global clone is used, the original is untouched). */
export function allMatches(pattern, text) {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  return [...String(text ?? '').matchAll(new RegExp(pattern.source, flags))];
}

// ── High-impact intent ──────────────────────────────────────────────────────────────
export const DEFAULT_HIGH_IMPACT_PATTERNS = [
  'dinero|pago|cobro|money|payment',
  'auth|autenticaci[oó]n|authentication|permiso|permission|credencial|credential|token|' +
    'sesi[oó]n|session|seguridad|security|PII',
  'borrar|delete|drop|migraci[oó]n|migration|schema',
  'contrato|contract|irreversible|producci[oó]n|production|API p[uú]blica|public api',
];
const CO_OCCURRENCE_WINDOW = 100;

/**
 * One boundary-wrapped pattern from a list of regex sources. Returns null for an empty or
 * non-array list (meaning: nothing is high-impact), and skips a malformed source instead
 * of throwing — one typo in config must not disable the gate or block everything.
 */
export function buildHighImpactPattern(sources) {
  if (!Array.isArray(sources)) return null;
  const valid = sources.filter((source) => {
    if (typeof source !== 'string' || !source.trim()) return false;
    try {
      new RegExp(source, 'iu');
      return true;
    } catch {
      return false;
    }
  });
  if (valid.length === 0) return null;
  return withUnicodeWordBoundary(
    valid.map((source) => `(?:${source})`).join('|'),
  );
}

/**
 * Two-stage intent check: a cheap prefilter (verb AND signal somewhere), then, on the
 * prompt with quoted text removed, a near co-occurrence of an implementation verb and a
 * high-impact signal where the verb's object is not a documentary deliverable.
 */
export function hasRealSensitiveMutation(prompt, highImpactPattern) {
  const raw = String(prompt ?? '');
  if (!highImpactPattern) return false;
  if (!(IMPLEMENTATION_VERBS.test(raw) && highImpactPattern.test(raw)))
    return false;

  const text = stripQuoted(raw);
  const verbs = allMatches(IMPLEMENTATION_VERBS, text);
  const signals = allMatches(highImpactPattern, text);
  for (const verb of verbs) {
    if (verbProducesDocument(text, verb)) continue;
    for (const signal of signals) {
      if (Math.abs(signal.index - verb.index) <= CO_OCCURRENCE_WINDOW)
        return true;
    }
  }
  return false;
}

// ── Declared LEVEL ──────────────────────────────────────────────────────────────────
export const LEVELS = Object.freeze({
  QUESTION: 'QUESTION',
  MICRO: 'MICRO',
  STANDARD: 'STANDARD',
  HIGH_RISK: 'HIGH-RISK',
});
export const DEMANDING_LEVELS = new Set([LEVELS.STANDARD, LEVELS.HIGH_RISK]);
export const EXEMPT_LEVELS = new Set([LEVELS.QUESTION, LEVELS.MICRO]);

// A level is "declared" when one of the four tokens sits within LEVEL_WINDOW characters after
// the word level/nivel/clasificación — across a colon, markdown bold, a short qualifier ("de
// riesgo") or a line break — so `**LEVEL**\nSTANDARD` reads, while a stray token far from
// the keyword does not count as a declaration.
const LEVEL_KEYWORD_PATTERN = /nivel|level|clasificaci[oó]n|classification/giu;
const LEVEL_TOKEN_PATTERN =
  /(QUESTION|MICRO|STANDARD|HIGH[-_ ]?RISK)(?![\p{L}\p{N}])/iu;
const LEVEL_WINDOW = 60;

function normalizeLevelToken(token) {
  const upper = token.toUpperCase();
  return upper.startsWith('HIGH') ? LEVELS.HIGH_RISK : upper;
}

/** Every LEVEL token declared in the prompt, in order of appearance. */
export function declaredLevelsOf(prompt) {
  const text = String(prompt ?? '');
  const levels = [];
  for (const keyword of text.matchAll(LEVEL_KEYWORD_PATTERN)) {
    const start = keyword.index + keyword[0].length;
    const token = LEVEL_TOKEN_PATTERN.exec(
      text.slice(start, start + LEVEL_WINDOW),
    );
    if (token) levels.push(normalizeLevelToken(token[1]));
  }
  return levels;
}

/**
 * The level that GOVERNS the prompt: the last one declared (a later declaration revises an
 * earlier one), or null when none is declared. A decoy `LEVEL: MICRO` placed before a real
 * `LEVEL: HIGH-RISK` therefore does not exempt anything.
 */
export function operativeLevelOf(prompt) {
  const levels = declaredLevelsOf(prompt);
  return levels.length === 0 ? null : levels.at(-1);
}

/** Whether the declared levels contradict each other (a demanding and an exempt level). */
export function hasAmbiguousLevel(prompt) {
  const levels = new Set(declaredLevelsOf(prompt));
  return (
    [...levels].some((level) => DEMANDING_LEVELS.has(level)) &&
    [...levels].some((level) => EXEMPT_LEVELS.has(level))
  );
}

// ── Harness paths ───────────────────────────────────────────────────────────────────
// Work ON the agent harness itself (Claude Code config, this plugin's own wiring, agent
// instructions) is exempt from the spec-driven pipeline gates. Deliberately NARROW: a bare
// `hooks/` or `settings.json` also lives in ordinary app code (React hooks, .vscode) and
// exempting those turned the gates off for every React/Vue project.
const HARNESS_PATH_PATTERNS = [
  /(?:^|[\s"'`(\\/])\.claude[\\/]/i,
  /(?:^|[\s"'`(\\/])\.ai[\\/]/i,
  /(?:^|[\s"'`(\\/])\.claude-plugin[\\/]/i,
  /(?:^|[\s"'`(\\/])(?:CLAUDE|AGENTS)\.md(?!\w)/i,
  /(?:^|[\s"'`(\\/])hooks[\\/]hooks\.json(?!\w)/i,
  /(?:^|[\s"'`(\\/])registry\.json(?!\w)/i,
];

/** Whether the prompt targets the agent harness rather than the product. */
export function isHarnessWork(prompt) {
  const text = String(prompt ?? '');
  return HARNESS_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

// ── Instruction vs. mention ─────────────────────────────────────────────────────────
// A delegation prompt can MENTION a forbidden command without ordering it: "confirm no
// script ever calls a hard reset", "do NOT run git push", "the user will push". A gate that
// greps the raw command regex over prose denies all of those. This looks at the words
// governing each mention: a reporting verb, a negation, or a third-party actor before it
// (within LOOK_BACK characters, same sentence) makes it a description, not an order.
const MENTION_LOOK_BACK = 80;
// Words that, in the same sentence before a mention, make it a description or a prohibition
// rather than an order. Each is a small boundary-wrapped pattern; tested one by one.
const DESCRIPTION_GOVERNOR_TERMS = [
  'describe|explain|summar\\p{L}*|mention\\p{L}*|document\\p{L}*|report|changelog',
  'confirm|verify|check|ensure|audit|grep|search|find|look for',
  "never|not|don'?t|do not|avoid|forbid|prohibit|instead of|without",
  'the user|user will|yourself|themselves',
  'no|nunca|jam[aá]s|evit\\p{L}*|prohib\\p{L}*|sin|en vez de|en lugar de|el usuario',
  'documenta|explica|resume|menciona|confirma|verifica|revisa|busca|audita',
];
const DESCRIPTION_GOVERNOR_PATTERNS = DESCRIPTION_GOVERNOR_TERMS.map((terms) =>
  withUnicodeWordBoundary(terms),
);

/** The part of `before` that belongs to the same sentence as the mention that follows it. */
function sameSentenceTail(before) {
  return before.split(/[.\n]/).at(-1) ?? '';
}

function isGovernedByDescription(before) {
  const tail = sameSentenceTail(before);
  return DESCRIPTION_GOVERNOR_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * Whether `pattern` matches the text as a real instruction: a non-quoted occurrence that is
 * not governed by a reporting verb, a negation or a third-party actor in the same sentence.
 */
export function hasRealCommandIntent(text, pattern) {
  const raw = String(text ?? '');
  if (!pattern.test(raw)) return false;
  const cleaned = stripQuoted(raw);
  return allMatches(pattern, cleaned).some((match) => {
    const from = Math.max(0, match.index - MENTION_LOOK_BACK);
    return !isGovernedByDescription(cleaned.slice(from, match.index));
  });
}

// ── Excerpts for messages ───────────────────────────────────────────────────────────
const PROMPT_EXCERPT_LENGTH = 80;

/** The start of a prompt, for quoting back in a deny message. */
export function promptExcerpt(prompt) {
  const text = String(prompt ?? '').trim();
  return text.length > PROMPT_EXCERPT_LENGTH
    ? `${text.slice(0, PROMPT_EXCERPT_LENGTH)}…`
    : text;
}

// ── Feature citations (spec-driven gates) ───────────────────────────────────────────
const FEATURE_CITATION_PATTERN = /\.(?:ai)[\\/]features[\\/]([\w.@-]+)/gi;

/** Feature names cited as `.ai/features/<name>` in a prompt, de-duplicated. */
export function featureNamesCitedIn(prompt) {
  const names = new Set();
  for (const match of String(prompt ?? '').matchAll(FEATURE_CITATION_PATTERN))
    names.add(match[1]);
  return [...names];
}
