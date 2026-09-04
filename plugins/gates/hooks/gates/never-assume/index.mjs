// never-assume — conjecture phrasing in a brief or in written code gets a reminder to verify.
// Advisory only: a guess is a prompt to check, never a blocker. Every pattern (default or
// configured) is word-bounded, so "might benefit" does not trip "might be".

import {
  runGate,
  warn,
  toolInGroups,
  writtenContentOf,
  delegationPromptOf,
  compileRegex,
} from '../../lib/hook-io.mjs';
import { CONJECTURE_SOURCES } from '../../lib/signals.mjs';

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
    `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    severity: 'warn',
    defaultParams: {
      conjecturePatterns: CONJECTURE_SOURCES,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['write', 'delegation'])) return;

    const content = extractContent(toolName, toolInput);
    if (!content) return;

    const hits = [];
    for (const source of parameters.conjecturePatterns) {
      const match = boundedPattern(source)?.exec(content);
      if (match) hits.push(match[0]);
    }
    if (hits.length === 0) return;

    warn(
      CONFIG_KEY,
      `Content contains conjecture phrasing without stated verification: ${hits.join(', ')}. ` +
        'Verify before asserting instead of assuming. This is advisory; to change the ' +
        `phrases, set conjecturePatterns for ${CONFIG_KEY} in .ai/config.json.`,
    );
  },
);
