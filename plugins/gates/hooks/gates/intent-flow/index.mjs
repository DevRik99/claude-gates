// intent-flow — denies an implementation delegation with real intent to mutate a high-impact
// area (money, auth, persisted data, public contract, irreversible...) unless it declares
// IN SCOPE / OUT OF SCOPE / EDGE CASES, and hard-denies when it also leaves a high-impact
// UNKNOWN unresolved.
//
// Decisions: brief-before-delegate asks "was the task thought through"; this gate asks the
// complementary "was the SCOPE declared" and the two never depend on each other. Intent is
// judged by the lib's two-stage check (verb + signal co-occurrence outside quoted text, with a
// documentary object discarded), not by a bare keyword hit. A read-only subagent name is a
// declared label, void whenever the prompt itself carries a mutation-risk signal. An empty
// `highImpactPatterns` means nothing is high-impact, so the gate stays silent.

import {
  DEFAULT_HIGH_IMPACT_PATTERNS,
  DEFAULT_READ_ONLY_SUBAGENTS,
  buildHighImpactPattern,
  hasRealSensitiveMutation,
  isExemptQuery,
  isImplementationRequest,
  isReadOnlySubagent,
  promptExcerpt,
  stripQuoted,
} from '../../lib/delegation.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { withUnicodeWordBoundary } from '../../lib/signals.mjs';

const GATE_ID = 'intent-flow';
const CONFIG_KEY = 'requireScopeListBeforeDelegating';

const MIN_REQUEST_LENGTH = 40;

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
    CONFIG_KEY,
    'This request touches a high-impact signal (money/auth/persisted data/public contract/' +
      'irreversible/production) AND declares an unresolved UNKNOWN. Do not relaunch assuming an ' +
      'answer — ask the user what to decide about that UNKNOWN before delegating again.',
  );
}

function denyTooShortForScopeList(prompt) {
  deny(
    CONFIG_KEY,
    `This implementation request ("${promptExcerpt(prompt)}") does not carry a scope list: missing IN ` +
      'SCOPE, OUT OF SCOPE and EDGE CASES. Add it to the prompt before relaunching.',
  );
}

function denyMissingSignals(missing) {
  deny(
    CONFIG_KEY,
    `This implementation request does not declare, in recognizable form: ${missing.join('; ')}. ` +
      'Add what is missing to the prompt before relaunching this delegation.',
  );
}

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
