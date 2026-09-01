import {
  runGate,
  warn,
  toolInGroups,
  writtenContentOf,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { CONJECTURE_SOURCES } from '../../lib/signals.mjs';

const GATE_ID = 'never-assume';
const CONFIG_KEY = 'requireVerificationBeforeAssuming';

// Bilingual (ES+EN) conjecture phrasing, centralized in lib/signals.mjs so every gate
// that needs to recognize unverified-assumption prose shares the same coverage. See
// signals.mjs header for the ES/EN-only limitation.
const DEFAULT_CONJECTURE_PATTERNS = CONJECTURE_SOURCES;

function extractContent(toolName, toolInput) {
  if (toolInGroups(toolName, ['delegation']))
    return delegationPromptOf(toolInput);
  return writtenContentOf(toolInput);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      conjecturePatterns: DEFAULT_CONJECTURE_PATTERNS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const isWrite = toolInGroups(toolName, ['write']);
    const isDelegation = toolInGroups(toolName, ['delegation']);
    if (!isWrite && !isDelegation) return;

    const content = extractContent(toolName, toolInput);
    if (!content) return;

    const patterns = parameters.conjecturePatterns.map(
      (source) => new RegExp(source, 'i'),
    );
    const hits = [];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) hits.push(match[0]);
    }
    if (hits.length === 0) return;

    warn(
      CONFIG_KEY,
      `Content contains conjecture phrasing without stated verification: ${hits.join(', ')}. Verify before asserting instead of assuming.`,
    );
  },
);

// The source guard (guard-never-assume.mjs) is explicit: this never denies,
// only warns — conjecture language is a prompt to verify, not a blocker.
