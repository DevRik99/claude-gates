// test-matrix — denies a STANDARD/HIGH-RISK implementation delegation whose brief touches a
// domain that makes a test type mandatory (money/auth/persistence → E2E; UI → visual/QA;
// always → unit/mutation) without that type declared in the prompt.
//
// Decisions: the E2E signals are the terms that name a money/auth/data-loss domain; generic
// words (role, balance, amount, session, token) were dropped because they fire on ordinary
// briefs. An empty `e2eSignals`/`visualSignals` means that row is never mandatory. A file
// extension signal (`.tsx`) matches a real path, so it is compiled without a leading word
// boundary. "QA:" counts as a visual row only when something follows it. Only the exempt
// list exempts a subagent type; harness work (.claude/, .ai/...) is exempt.

import {
  DEFAULT_EXEMPT_SUBAGENTS,
  DEMANDING_LEVELS,
  isHarnessWork,
  isImplementationRequest,
  isSubagentNamedIn,
  operativeLevelOf,
} from '../../lib/delegation.mjs';
import {
  runGate,
  deny,
  compileRegex,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { withUnicodeWordBoundary } from '../../lib/signals.mjs';

const GATE_ID = 'test-matrix';
const CONFIG_KEY = 'requireTestMatrixWhenImplementing';

const DEFAULT_E2E_SIGNALS = [
  'money|payment|pago|dinero|cobro|charge|invoice|factura|precio|price|saldo|monto|cuota|checkout',
  'auth|autenticaci[oó]n|authentication|login|password|contrase[nñ]a|credencial|credential',
  'persist|database|migration|transaction|persistencia|base de datos|migraci[oó]n|transacci[oó]n',
  'data loss|p[eé]rdida de datos|delete|borrar|drop',
];

const DEFAULT_VISUAL_SIGNALS = [
  'ui|interface|interfaz|component|componente|screen|pantalla|view|vista',
  'form|formulario|button|bot[oó]n|modal|layout|style|estilo',
  'responsive|mobile|m[oó]vil|visual',
  '\\.(vue|tsx?|jsx?)(?!\\w)',
];

const DETECTS_E2E = /\b(e2e|end[- ]to[- ]end|playwright)\b/i;
const DETECTS_VISUAL = /\b(visual|qa\s*:\s*\p{L}|screenshot|snapshot)/iu;
const DETECTS_UNIT_OR_MUTATION =
  /\b(unit\b|units\b|unitari[ao]s?|vitest|jest|mutation|mutaci[oó]n|mutant|stryker)\b/i;
const DETECTS_NEGATIVE_CASES = withUnicodeWordBoundary(
  'negative|edge|empty|error|no data|zero|count 0|failure|invalid|limit|' +
    'negativ[ao]s?|borde|vac[ií]o|sin datos|cero|falla|inv[aá]lid[ao]|l[ií]mite',
);

// A source that starts with an escaped dot is a file-extension shape and must match inside
// a path; every other source is a word and gets the Unicode word boundary.
function compileSignal(source) {
  if (typeof source !== 'string' || !compileRegex(source, 'iu')) return null;
  return source.startsWith('\\.')
    ? compileRegex(source, 'iu')
    : withUnicodeWordBoundary(source);
}

function anySignalMatches(sources, prompt) {
  return sources
    .map(compileSignal)
    .filter(Boolean)
    .some((pattern) => pattern.test(prompt));
}

function isExempt(toolInput, prompt, exemptSubagents) {
  if (isSubagentNamedIn(toolInput, exemptSubagents)) return true;
  if (!DEMANDING_LEVELS.has(operativeLevelOf(prompt))) return true;
  if (!isImplementationRequest(prompt)) return true;
  return isHarnessWork(prompt);
}

function missingTypes(prompt, e2eSignals, visualSignals) {
  const missing = [];

  if (!DETECTS_UNIT_OR_MUTATION.test(prompt)) {
    missing.push({
      type: 'unit/mutation',
      line: '- unit/mutation: yes — <what it covers>  (or: not applicable — <reason>)',
    });
  }

  if (anySignalMatches(e2eSignals, prompt) && !DETECTS_E2E.test(prompt)) {
    missing.push({
      type: 'E2E',
      line: '- E2E: yes — <end-to-end flow verified>  (mandatory: the requirement touches money/auth/persistence)',
    });
  }

  if (anySignalMatches(visualSignals, prompt) && !DETECTS_VISUAL.test(prompt)) {
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
    if (isExempt(toolInput, prompt, parameters.exemptSubagents)) return;

    const missing = missingTypes(
      prompt,
      parameters.e2eSignals,
      parameters.visualSignals,
    );
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
