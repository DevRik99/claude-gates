// intent-flow — denies an implementation delegation that has real intent to mutate a
// high-impact area (money, auth, persisted data, public contract, irreversible...)
// without declaring IN SCOPE / OUT OF SCOPE / EDGE CASES, and hard-denies whenever it
// also leaves a high-impact UNKNOWN unresolved.
//
// ── How this differs from brief-before-delegate ─────────────────────────────────────
// brief-before-delegate asks "was the task thought through" (goal+steps+criterion).
// This gate asks a different, complementary question: "was the SCOPE declared — what
// is in, what is explicitly out, and what edge cases were considered — for work that
// really intends to touch a sensitive area?" Both run on the same delegation prompt
// independently; neither depends on the other's verdict.
//
// ── Two-stage intent check (not lexical match) ──────────────────────────────────────
// Stage 1 (cheap prefilter): does the raw prompt contain BOTH an implementation verb
// and a high-impact signal anywhere? If not, there is no candidate — allow immediately.
// Stage 2 (confirmation, only on candidates): strip quoted/templated text, then require
// near co-occurrence between an implementation verb and a high-impact signal, and
// discard a verb whose immediate object is a documentary deliverable (a doc/report/
// README/.md/.html describing the area is not mutating it). Only surviving (a)+(b)+(c)
// counts as real intent.
//
// ── readOnlySubagents is a declared label, not a verified capability ────────────────
// This hook cannot check what tools a named subagent actually has — the whitelist
// exemption is void whenever the prompt itself carries a mutation-risk signal (money/
// auth/data/write/deploy): the signal in the text outranks the label on the call.

import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { MUTATION_RISK_SIGNAL } from '../../lib/signals.mjs';

const GATE_ID = 'intent-flow';
const CONFIG_KEY = 'requireScopeListBeforeDelegating';

const DEFAULT_READ_ONLY_SUBAGENTS = ['explore', 'claude-code-guide', 'plan'];
const DEFAULT_HIGH_IMPACT_PATTERNS = [
  'dinero|pago|cobro|money|payment',
  'auth|autenticaci[oó]n|authentication|permiso|permission|token|sesi[oó]n|session|seguridad|security|PII',
  'borrar|delete|drop|migraci[oó]n|migration|schema',
  'contrato|contract|irreversible|producci[oó]n|production|API p[uú]blica|public api',
];

const MIN_REQUEST_LENGTH = 40;
const CO_OCCURRENCE_WINDOW = 100;
const VERB_OBJECT_WINDOW = 60;
// How much of an over-length prompt to quote back in a denial message.
const PROMPT_EXCERPT_LENGTH = 80;

function withUnicodeWordBoundary(alternatives) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(${alternatives})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

// A prompt-level signal that a whitelisted read-only subagent name should NOT be
// trusted to exempt this call: the name is a declared label, never a verified
// capability this hook can check, and real mutation risk in the text must win over it.
// Deliberately broad — over-including only means this gate's check still runs.
// Centralized in lib/signals.mjs (ES+EN) — see its header for the class this covers.
const MUTATION_RISK_SIGNAL_PATTERN = MUTATION_RISK_SIGNAL;

const IMPLEMENTATION_VERBS = withUnicodeWordBoundary(
  'implementa|implementar|implement(á|é)|agreg(a|á)|agregar|añad(e|í)|añadir|cre(a|á)|crear|' +
    'arregl(a|á)|arreglar|cambi(a|á)|cambiar|migr(a|á)|migrar|escrib(í|e) c[oó]digo|escribir c[oó]digo|' +
    'corrige|corregir|correg(í|ir)|constru(ye|í)|construir|modific(a|á)|modificar|' +
    'refactoriz(a|á)|refactorizar|elimin(a|á)|eliminar|reescrib(e|í)|reescribir|desplieg(a|á)|desplegar|' +
    'implement|build|fix|migrate|modify|refactor|remove|rewrite|deploy',
);

const QUERY_VERBS = withUnicodeWordBoundary(
  'explica|explic(á|ar)|qu[eé]|c[oó]mo|muestra|mostr(á|ar)|analiza|analiz(á|ar)|investiga|' +
    'investig(á|ar)|revisa|revis(á|ar)|audita|audit(á|ar)|diagnostica|diagnostic(á|ar)|' +
    'explain|what|how|show|analyze|investigate|review|audit|diagnose',
);

const IN_SCOPE_PATTERN = withUnicodeWordBoundary(
  'qu[eé] s[ií]|qu[eé] s[ií] entra|alcance|in scope|lo pedido|se va a hacer|incluye',
);
const OUT_OF_SCOPE_PATTERN = withUnicodeWordBoundary(
  'qu[eé] no|fuera de alcance|out of scope|no tocar|no modificar|no debe cambiar|' +
    'must not change|no se debe (cambiar|tocar|modificar)',
);
const EDGE_CASES_PATTERN = withUnicodeWordBoundary(
  'edge cases?|edge-cases?|casos? borde|casos? l[ií]mite|caso l[ií]mite|sin edge cases|' +
    'no (hay|aplican) edge cases|no hay casos borde',
);
const UNRESOLVED_UNKNOWN_PATTERN = withUnicodeWordBoundary(
  'unknown|no se sabe|no sabemos|sin resolver|no est[aá] claro|no est[aá] definido|' +
    'a definir|por definir|desconocido|no est[aá] decidido',
);
const DOCUMENTARY_DELIVERABLE_PATTERN = withUnicodeWordBoundary(
  'documento|documentaci[oó]n|reporte|informe|diagrama|readme|wiki|changelog|' +
    'p[aá]gina de documentaci[oó]n|archivo html|p[aá]gina html|markdown|document|documentation|report',
);
const DOCUMENTARY_EXTENSION_PATTERN = /\.(md|html?|adoc)\b/iu;

function isReadOnlySubagentName(toolInput, readOnlySubagents) {
  const type = String(
    toolInput.subagent_type ?? toolInput.subagentType ?? '',
  ).toLowerCase();
  return new Set(readOnlySubagents.map((name) => name.toLowerCase())).has(type);
}

/** A whitelisted subagent name exempts a call ONLY when the prompt carries no
 * mutation-risk signal. The name is a declared label, never a verified capability this
 * hook can check — a real risk signal in the text must win over it. */
function isReadOnlySubagent(toolInput, prompt, readOnlySubagents) {
  if (!isReadOnlySubagentName(toolInput, readOnlySubagents)) return false;
  return !MUTATION_RISK_SIGNAL_PATTERN.test(prompt);
}

function isImplementationRequest(prompt) {
  return IMPLEMENTATION_VERBS.test(prompt);
}

function isExemptQuery(prompt) {
  if (isImplementationRequest(prompt)) return false; // implementation verb takes priority
  return QUERY_VERBS.test(prompt);
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

function verbProducesDocument(text, verbMatch) {
  const from = verbMatch.index;
  const to = from + verbMatch[0].length + VERB_OBJECT_WINDOW;
  const objectOfVerb = text.slice(from, to);
  return (
    DOCUMENTARY_DELIVERABLE_PATTERN.test(objectOfVerb) ||
    DOCUMENTARY_EXTENSION_PATTERN.test(objectOfVerb)
  );
}

function hasRealSensitiveMutation(prompt, highImpactPattern) {
  const isCandidate =
    IMPLEMENTATION_VERBS.test(prompt) && highImpactPattern.test(prompt);
  if (!isCandidate) return false; // stage 1: cheap, no stage 2 spent

  const text = stripQuoted(prompt); // stage 2(a)
  const verbs = allMatches(IMPLEMENTATION_VERBS, text);
  const signals = allMatches(highImpactPattern, text);

  for (const verb of verbs) {
    if (verbProducesDocument(text, verb)) continue; // stage 2(c)
    for (const signal of signals) {
      if (Math.abs(signal.index - verb.index) <= CO_OCCURRENCE_WINDOW)
        return true; // stage 2(b)
    }
  }
  return false;
}

function missingSignals(prompt) {
  const missing = [];
  if (!IN_SCOPE_PATTERN.test(prompt))
    missing.push('IN SCOPE (what is requested, stated explicitly)');
  if (!OUT_OF_SCOPE_PATTERN.test(prompt))
    missing.push('OUT OF SCOPE (what must not be touched)');
  if (!EDGE_CASES_PATTERN.test(prompt)) {
    missing.push(
      'EDGE CASES (considered, or an explicit mark that none apply)',
    );
  }
  return missing;
}

function denyUnresolvedUnknown() {
  deny(
    GATE_ID,
    'This request touches a high-impact signal (money/auth/persisted data/public contract/' +
      'irreversible/production) AND declares an unresolved UNKNOWN. Do not relaunch assuming an ' +
      'answer — ask the user what to decide about that UNKNOWN before delegating again.',
  );
}

function denyTooShortForScopeList(prompt) {
  const excerpt = prompt.slice(0, PROMPT_EXCERPT_LENGTH);
  const ellipsis = prompt.length > PROMPT_EXCERPT_LENGTH ? '…' : '';
  deny(
    GATE_ID,
    `This implementation request ("${excerpt}${ellipsis}") does not carry a scope list: missing IN ` +
      'SCOPE, OUT OF SCOPE and EDGE CASES. Add it to the prompt before relaunching.',
  );
}

function denyMissingSignals(missing) {
  deny(
    GATE_ID,
    `This implementation request does not declare, in recognizable form: ${missing.join('; ')}. ` +
      'Add what is missing to the prompt before relaunching this delegation.',
  );
}

function buildHighImpactPattern(highImpactPatterns) {
  return new RegExp(
    (highImpactPatterns ?? []).map((source) => `(?:${source})`).join('|'),
    'iu',
  );
}

/** True when this delegation is exempt from the whole check: not a recognizable
 * implementation request, a read-only subagent, or an exempt query. */
function isExempt(toolInput, prompt, readOnlySubagents) {
  if (!prompt.trim()) return true;
  if (isReadOnlySubagent(toolInput, prompt, readOnlySubagents)) return true;
  if (isExemptQuery(prompt)) return true;
  return !isImplementationRequest(prompt);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      highImpactPatterns: DEFAULT_HIGH_IMPACT_PATTERNS,
      readOnlySubagents: DEFAULT_READ_ONLY_SUBAGENTS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (isExempt(toolInput, prompt, parameters.readOnlySubagents)) return;

    const highImpactPattern = buildHighImpactPattern(
      parameters.highImpactPatterns,
    );
    if (!hasRealSensitiveMutation(prompt, highImpactPattern)) return;

    if (UNRESOLVED_UNKNOWN_PATTERN.test(stripQuoted(prompt))) {
      denyUnresolvedUnknown();
    }

    const trimmed = prompt.trim();
    if (trimmed.length < MIN_REQUEST_LENGTH) {
      denyTooShortForScopeList(trimmed);
    }

    const missing = missingSignals(prompt);
    if (missing.length === 0) return;

    denyMissingSignals(missing);
  },
);
