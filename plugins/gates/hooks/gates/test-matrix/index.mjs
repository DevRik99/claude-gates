// test-matrix — denies an implementation delegation whose brief touches a domain that
// makes a test type mandatory (money/auth/persistence → E2E; UI → visual/QA; always →
// unit/mutation) without that type declared in the prompt. Migrated from
// ~/.claude/hooks/guard-matriz-de-tests.mjs.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   e2eSignals       regex sources (matched case-insensitively) that make an E2E row
//                     mandatory when found in the brief (money, auth, persistence...).
//                     Replaces the built-in list wholesale.
//   visualSignals    regex sources that make a visual/QA row mandatory (UI signals).
//                     Replaces the built-in list wholesale.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.
//
// ── Off by default, and quiet outside its narrow trigger ───────────────────────────
// Only STANDARD/HIGH-RISK implementation delegations on builder subagents, not about
// the harness itself, reach the check. A brief that only describes work never triggers.

import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { RISK_SIGNAL_SOURCES } from '../../lib/signals.mjs';

const GATE_ID = 'test-matrix';
const CONFIG_KEY = 'requireTestMatrixWhenImplementing';

const DEFAULT_EXEMPT_SUBAGENTS = [
  'scout',
  'explore',
  'plan',
  'revision',
  'contraste',
  'test-planner',
  'qa',
  'ui',
  'ux',
];

// Money/auth signals shared with RISK_SIGNAL (lib/signals.mjs, ES+EN), plus this gate's
// own persistence-domain terms (also bilingual) — a project override still replaces the
// whole list wholesale, same as before.
const DEFAULT_E2E_SIGNALS = [
  ...RISK_SIGNAL_SOURCES.slice(0, 2), // money terms, auth terms
  'login|session|token|permission|role|sesi[oó]n|permiso|rol',
  'persist|database|migration|transaction|persistencia|base de datos|migraci[oó]n|transacci[oó]n',
];

const DEFAULT_VISUAL_SIGNALS = [
  'ui|interface|interfaz|component|componente|screen|pantalla|view|vista',
  'form|formulario|button|bot[oó]n|modal|layout|style|estilo',
  'responsive|mobile|m[oó]vil|visual|\\.vue|\\.tsx?|\\.jsx?',
];

function withWordBoundary(alternation) {
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])(?:${alternation})(?:[^\\p{L}\\p{N}_]|$)`,
    'iu',
  );
}

const IMPLEMENTATION_VERBS = withWordBoundary(
  'implementa|implementar|implement(á|é)|agreg(a|á)|agregar|añad(e|í)|añadir|cre(a|á)|crear|' +
    'arregl(a|á)|arreglar|cambi(a|á)|cambiar|migr(a|á)|migrar|' +
    'corrige|corregir|correg(í|ir)|constru(ye|í)|construir|modific(a|á)|modificar|' +
    'refactoriz(a|á)|refactorizar|elimin(a|á)|eliminar|reescrib(e|í)|reescribir|desplieg(a|á)|desplegar|' +
    'escrib(í|e)|escribir|implement\\w*|writ(?:e|ing)|creat\\w*|fix\\w*|build\\w*|refactor\\w*|migrat\\w*|' +
    'add\\w*|remov\\w*|delet\\w*|modify|modifies|modifying|rewrit\\w*',
);

/** Declared LEVEL near the word "level"/"classification" in Spanish or English, matching
 * the plugin-wide convention (see risk-level.mjs). */
const DEMANDING_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(STANDARD|HIGH-RISK)\b/iu;
const EXEMPT_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(QUESTION|MICRO)\b/iu;

const HARNESS_PATTERN =
  /(\.claude[\\/]|hooks[\\/]|plugins[\\/]gates|settings\.json|[\\/]agents[\\/]\w|[\\/]rules[\\/]\w|[\\/]skills[\\/]\w)/i;

const DETECTS_E2E = /\b(e2e|end[- ]to[- ]end|playwright)\b/i;
const DETECTS_VISUAL = /\b(visual|qa\b|screenshot|snapshot)\b/i;
const DETECTS_UNIT_OR_MUTATION =
  /\b(unit\b|units\b|unitari[ao]s?|vitest|jest|mutation|mutaci[oó]n|mutant|stryker)\b/i;
const DETECTS_NEGATIVE_CASES = withWordBoundary(
  'negative|edge|empty|error|no data|zero|count 0|failure|invalid|limit|' +
    'negativ[ao]s?|borde|vac[ií]o|sin datos|cero|falla|inv[aá]lid[ao]|l[ií]mite',
);

function joinSignals(signals) {
  return withWordBoundary(signals.join('|'));
}

function isExempt(toolInput, prompt, exemptSubagents) {
  const subagentType = String(
    toolInput.subagent_type ?? toolInput.subagentType ?? '',
  ).toLowerCase();
  if (exemptSubagents.includes(subagentType)) return true;
  if (EXEMPT_LEVEL_PATTERN.test(prompt)) return true;
  if (!DEMANDING_LEVEL_PATTERN.test(prompt)) return true;
  if (!IMPLEMENTATION_VERBS.test(prompt)) return true;
  if (HARNESS_PATTERN.test(prompt)) return true;
  return false;
}

/** Which mandatory test types are missing from the prompt, given the brief text. */
function missingTypes(prompt, e2ePattern, visualPattern) {
  const missing = [];

  if (!DETECTS_UNIT_OR_MUTATION.test(prompt)) {
    missing.push({
      type: 'unit/mutation',
      line: '- unit/mutation: yes — <what it covers>  (or: not applicable — <reason>)',
    });
  }

  if (e2ePattern.test(prompt) && !DETECTS_E2E.test(prompt)) {
    missing.push({
      type: 'E2E',
      line: '- E2E: yes — <end-to-end flow verified>  (mandatory: the requirement touches money/auth/persistence)',
    });
  }

  if (visualPattern.test(prompt) && !DETECTS_VISUAL.test(prompt)) {
    missing.push({
      type: 'visual/QA',
      line: '- visual/QA: yes — <screen/state reviewed in the browser>  (mandatory: the requirement touches UI)',
    });
  }

  const declaresAnyType =
    DETECTS_UNIT_OR_MUTATION.test(prompt) ||
    DETECTS_E2E.test(prompt) ||
    DETECTS_VISUAL.test(prompt);
  if (declaresAnyType && !DETECTS_NEGATIVE_CASES.test(prompt)) {
    missing.push({
      type: 'negative/edge cases',
      line: '- negative/edge cases: <no data / empty / error / zero value / invalid input tested>  (the happy path is not enough)',
    });
  }

  return missing;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      exemptSubagents: DEFAULT_EXEMPT_SUBAGENTS,
      e2eSignals: DEFAULT_E2E_SIGNALS,
      visualSignals: DEFAULT_VISUAL_SIGNALS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;

    const exemptSubagents =
      parameters.exemptSubagents ?? DEFAULT_EXEMPT_SUBAGENTS;
    if (isExempt(toolInput, prompt, exemptSubagents)) return;

    const e2eSignals = parameters.e2eSignals ?? DEFAULT_E2E_SIGNALS;
    const visualSignals = parameters.visualSignals ?? DEFAULT_VISUAL_SIGNALS;
    const e2ePattern = joinSignals(e2eSignals);
    const visualPattern = joinSignals(visualSignals);

    const missing = missingTypes(prompt, e2ePattern, visualPattern);
    if (missing.length === 0) return;

    const lines = missing.map((entry) => `  ${entry.line}`).join('\n');
    deny(
      CONFIG_KEY,
      `Missing ${missing.length} test type(s) the requirement makes mandatory. Test types ` +
        'are chosen ACCORDING TO THE REQUIREMENT: E2E if it touches money/auth/persistence, ' +
        'visual/QA if it touches UI, and always unit or mutation. ' +
        `PASTE THIS SECTION INTO THE PROMPT (adjust yes/no with judgment) AND RELAUNCH:\n` +
        `TEST MATRIX (by type, according to the requirement):\n${lines}\n` +
        'A type that truly does not apply is declared "no — <reason>", never silently omitted.',
    );
  },
);
