// never-assume — two different assumptions, judged differently.
//
// CONJECTURE ("probably", "should be", "supongo") announces itself as a guess, so it only
// earns a reminder. Advisory by design: a stated guess is a prompt to check, not an offense.
// Because a text that ALREADY labels its own uncertainty ("hypothesis", "sin verificar") has
// nothing left to be reminded of, the reminder is dropped there instead of landing on the
// one author who did the right thing.
//
// An UNVERIFIED CLAIM ("already works", "ya funciona", "looks good") does the opposite — it
// states as settled fact something nobody checked, and the next reader inherits it as true.
// That is the assumption that actually costs: a brief telling a subagent the parser is
// already done sends it to build on something that may not exist. So a claim is DENIED
// unless the same content also carries evidence a reader could re-check (an exit code, a
// pass count, a --check). Say what you ran, or do not say it is done.
//
// Every pattern (default or configured) is word-bounded, so "might benefit" does not trip
// "might be".

import {
  runGate,
  deny,
  warn,
  toolInGroups,
  writtenContentOf,
  delegationPromptOf,
  compileRegex,
} from '../../lib/hook-io.mjs';
import {
  CONJECTURE_SOURCES,
  EVIDENCE_SOURCES,
  UNCERTAINTY_LABEL_SOURCES,
  UNVERIFIED_CLAIM_SOURCES,
  withFlexibleSpaces,
} from '../../lib/signals.mjs';

const GATE_ID = 'never-assume';
const CONFIG_KEY = 'requireVerificationBeforeAssuming';

function extractContent(toolName, toolInput) {
  if (toolInGroups(toolName, ['delegation']))
    return delegationPromptOf(toolInput);
  return writtenContentOf(toolInput);
}

// Same boundary as signals.withUnicodeWordBoundary, applied per source so an invalid
// config entry is skipped instead of poisoning the whole alternation.
function boundedPattern(source) {
  if (typeof source !== 'string' || source.length === 0) return null;
  return compileRegex(
    `(?<![\\p{L}\\p{N}_])(?:${withFlexibleSpaces(source)})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

function matchesIn(sources, content) {
  const hits = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const match = boundedPattern(source)?.exec(content);
    if (match) hits.push(match[0]);
  }
  return hits;
}

function hasAny(sources, content) {
  return matchesIn(sources, content).length > 0;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    severity: 'warn',
    defaultParams: {
      conjecturePatterns: CONJECTURE_SOURCES,
      unverifiedClaimPatterns: UNVERIFIED_CLAIM_SOURCES,
      evidencePatterns: EVIDENCE_SOURCES,
      uncertaintyLabelPatterns: UNCERTAINTY_LABEL_SOURCES,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['write', 'delegation'])) return;

    const content = extractContent(toolName, toolInput);
    if (!content) return;

    const claims = matchesIn(parameters.unverifiedClaimPatterns, content);
    if (claims.length > 0 && !hasAny(parameters.evidencePatterns, content)) {
      deny(
        CONFIG_KEY,
        `This states something is done or correct without saying what was checked: ` +
          `${claims.join(', ')}. Nobody reading it can tell the difference between a ` +
          'verified fact and an assumption, and the next agent inherits it as true.\n' +
          'Name the check in the same text — the command and its exit code, the pass ' +
          'count, the path that exists — or describe what you did instead of declaring ' +
          `the outcome. To adjust the phrases, set unverifiedClaimPatterns for ` +
          `${CONFIG_KEY} in .ai/config.json.`,
      );
    }

    const hits = matchesIn(parameters.conjecturePatterns, content);
    if (hits.length === 0) return;
    if (hasAny(parameters.uncertaintyLabelPatterns, content)) return;

    warn(
      CONFIG_KEY,
      `Content contains conjecture phrasing without stated verification: ${hits.join(', ')}. ` +
        'Verify before asserting instead of assuming. This is advisory; to change the ' +
        `phrases, set conjecturePatterns for ${CONFIG_KEY} in .ai/config.json.`,
    );
  },
);
