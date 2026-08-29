import { runGate, warn, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'never-assume';
const CONFIG_KEY = 'requireVerificationBeforeAssuming';

const DEFAULT_CONJECTURE_PATTERNS = [
  'i assume',
  'assuming that',
  'probably',
  'i guess',
  'should be',
  "i'll default to",
];

function extractContent(toolName, toolInput) {
  if (TOOL_GROUPS.delegation.includes(toolName)) return toolInput?.prompt;
  return toolInput?.content ?? toolInput?.new_string;
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
    const isWrite = TOOL_GROUPS.write.includes(toolName);
    const isDelegation = TOOL_GROUPS.delegation.includes(toolName);
    if (!isWrite && !isDelegation) return;

    const content = extractContent(toolName, toolInput);
    if (typeof content !== 'string') return;

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
      GATE_ID,
      `Content contains conjecture phrasing without stated verification: ${hits.join(', ')}. Verify before asserting instead of assuming.`,
    );
  },
);

// The source guard (guard-never-assume.mjs) is explicit: this never denies,
// only warns — conjecture language is a prompt to verify, not a blocker.
