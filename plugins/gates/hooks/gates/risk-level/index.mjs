// risk-level — denies an implementation delegation that does not declare its risk
// LEVEL (QUESTION|MICRO|STANDARD|HIGH-RISK), and denies a declared level that
// contradicts a real high-impact signal in the prompt itself (anything but HIGH-RISK).
//
// ── What this does and does not decide ──────────────────────────────────────────────
// Classifying a task correctly between QUESTION/MICRO/STANDARD stays the delegator's
// judgment — this gate cannot tell whether STANDARD was the "right" level for a task
// with no detectable high-impact signal. The only deterministic thing it can and does
// impose: the declaration EXISTS, and it does not contradict a real, non-quoted signal
// of high risk. The level vocabulary itself (the four tokens) is a fixed base, not a
// project param — only which signals count as high-impact, and which subagents are
// exempt, are configurable.
//
// ── Same two-stage intent pattern as intent-flow ────────────────────────────────────
// Stage 1: cheap lexical prefilter (implementation verb + high-impact signal present
// anywhere). Stage 2: strip quoted/templated text, require near co-occurrence between
// the verb and the signal, discard a verb whose object is a documentary deliverable.
// Over-declaring HIGH-RISK is never penalized — this gate only catches under-declaring.

import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'risk-level';
const CONFIG_KEY = 'requireDeclaredRiskLevel';

const DELEGATION_TOOLS = new Set(TOOL_GROUPS.delegation);

const DEFAULT_READ_ONLY_SUBAGENTS = ['explore', 'claude-code-guide', 'plan'];
const DEFAULT_HIGH_IMPACT_PATTERNS = [
  'dinero|pago|cobro|money|payment',
  'auth|autenticaci[oó]n|authentication|permiso|permission|credencial|credential|token|' +
    'sesi[oó]n|session|seguridad|security|PII',
  'borrar|delete|drop|migraci[oó]n|migration|schema',
  'contrato|contract|irreversible|producci[oó]n|production|API p[uú]blica|public api',
];

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

const IMPLEMENTATION_VERBS = withUnicodeWordBoundary(
  'implementa|implementar|implement(á|é)|agreg(a|á)|agregar|añad(e|í)|añadir|cre(a|á)|crear|' +
    'arregl(a|á)|arreglar|cambi(a|á)|cambiar|migr(a|á)|migrar|escrib(í|e) c[oó]digo|escribir c[oó]digo|' +
    'corrige|corregir|correg(í|ir)|constru(ye|í)|construir|modific(a|á)|modificar|' +
    'refactoriz(a|á)|refactorizar|elimin(a|á)|eliminar|reescrib(e|í)|reescribir|desplieg(a|á)|desplegar|' +
    'escrib(í|e)|escribir|implement|build|fix|migrate|modify|refactor|remove|rewrite|deploy|write',
);

const QUERY_VERBS = withUnicodeWordBoundary(
  'explica|explic(á|ar)|qu[eé]|c[oó]mo|muestra|mostr(á|ar)|analiza|analiz(á|ar)|investiga|' +
    'investig(á|ar)|revisa|revis(á|ar)|audita|audit(á|ar)|diagnostica|diagnostic(á|ar)|' +
    'explain|what|how|show|analyze|investigate|review|audit|diagnose',
);

const DOCUMENTARY_DELIVERABLE_PATTERN = withUnicodeWordBoundary(
  'documento|documentaci[oó]n|reporte|informe|diagrama|readme|wiki|changelog|' +
    'p[aá]gina de documentaci[oó]n|archivo html|p[aá]gina html|markdown|document|documentation|report',
);
const DOCUMENTARY_EXTENSION_PATTERN = /\.(md|html?|adoc)\b/iu;

/** Declared LEVEL: one of the four fixed tokens, near the word "level"/"classification"
 * (in Spanish or English) so a stray mention elsewhere in the prompt is not mistaken
 * for a declaration. */
const DECLARED_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(QUESTION|MICRO|STANDARD|HIGH-RISK)\b/iu;

function isReadOnlySubagent(toolInput, readOnlySubagents) {
  const type = String(
    toolInput.subagent_type ?? toolInput.subagentType ?? '',
  ).toLowerCase();
  return new Set(readOnlySubagents.map((name) => name.toLowerCase())).has(type);
}

function isImplementationRequest(prompt) {
  return IMPLEMENTATION_VERBS.test(prompt);
}

function isExemptQuery(prompt) {
  if (isImplementationRequest(prompt)) return false;
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

/** Returns the matched high-impact signal text if real (non-quoted) intent survives
 * stage 2, else null. Returns null immediately when stage 1 finds no candidate. */
function realHighImpactSignal(prompt, highImpactPattern) {
  const isCandidate =
    IMPLEMENTATION_VERBS.test(prompt) && highImpactPattern.test(prompt);
  if (!isCandidate) return null;

  const text = stripQuoted(prompt);
  const verbs = allMatches(IMPLEMENTATION_VERBS, text);
  const signals = allMatches(highImpactPattern, text);

  for (const verb of verbs) {
    if (verbProducesDocument(text, verb)) continue;
    for (const signal of signals) {
      if (Math.abs(signal.index - verb.index) <= CO_OCCURRENCE_WINDOW)
        return signal[0];
    }
  }
  return null;
}

function declaredLevel(prompt) {
  const match = DECLARED_LEVEL_PATTERN.exec(prompt);
  return match ? match[2].toUpperCase() : null;
}

function denyNoLevelDeclared(prompt) {
  const excerpt = prompt.slice(0, PROMPT_EXCERPT_LENGTH);
  const ellipsis = prompt.length > PROMPT_EXCERPT_LENGTH ? '…' : '';
  deny(
    GATE_ID,
    `This implementation delegation ("${excerpt}${ellipsis}") does not declare its risk LEVEL. Add a ` +
      'line such as "LEVEL: STANDARD" (or QUESTION/MICRO/HIGH-RISK, whichever fits) before relaunching ' +
      'this delegation.',
  );
}

function denyLevelContradictsSignal(level, signal) {
  deny(
    GATE_ID,
    `This delegation declares LEVEL: ${level}, but the request touches the risk signal "${signal}" near ` +
      'an implementation verb (not quoted, not the topic of a documentary deliverable) — that requires ' +
      `LEVEL: HIGH-RISK, not ${level}. Raise the declaration to HIGH-RISK before relaunching.`,
  );
}

function buildHighImpactPattern(highImpactPatterns) {
  return new RegExp(
    (highImpactPatterns ?? []).map((source) => `(?:${source})`).join('|'),
    'iu',
  );
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
    if (!DELEGATION_TOOLS.has(toolName)) return;

    const prompt = String(
      toolInput.prompt ?? toolInput.description ?? toolInput.task ?? '',
    );
    if (!prompt.trim()) return;
    if (isReadOnlySubagent(toolInput, parameters.readOnlySubagents)) return;
    if (isExemptQuery(prompt)) return;
    if (!isImplementationRequest(prompt)) return;

    const highImpactPattern = buildHighImpactPattern(
      parameters.highImpactPatterns,
    );

    const level = declaredLevel(prompt);
    const signal = realHighImpactSignal(prompt, highImpactPattern);

    if (!level) {
      denyNoLevelDeclared(prompt.trim());
    }

    if (signal && level !== 'HIGH-RISK') {
      denyLevelContradictsSignal(level, signal);
    }
  },
);
