import { runGate, warn, toolInGroups, writtenContentOf } from '../../lib/hook-io.mjs';

const GATE_ID = 'diagnosis-before-patch';
const CONFIG_KEY = 'warnTimeoutChangeWithoutDiagnosis';

const DEFAULT_TIMEOUT_PATTERNS = [
  String.raw`\b[A-Z_]*TIMEOUT[A-Z_]*\s*[:=]\s*['"]?\d`,
  String.raw`\b[A-Z_]*DEADLINE[A-Z_]*\s*[:=]\s*['"]?\d`,
  String.raw`\b[A-Z_]*IDLE[A-Z_]*\s*[:=]\s*['"]?\d`,
  String.raw`\b(max_?retry|retries|backoff)\b\s*[:=]\s*['"]?\d`,
  String.raw`\b(query_?timeout|hard_?deadline)\b`,
];

function extractText(toolName, toolInput) {
  if (!toolInGroups(toolName, ['write'])) return '';
  return writtenContentOf(toolInput);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      timeoutPatterns: DEFAULT_TIMEOUT_PATTERNS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const text = extractText(toolName, toolInput);
    if (!text) return;

    const patterns = parameters.timeoutPatterns.map(
      (source) => new RegExp(source, 'i'),
    );
    const touchesTimeout = patterns.some((pattern) => pattern.test(text));
    if (!touchesTimeout) return;

    warn(
      GATE_ID,
      'Diagnosis before patch: you are adjusting a timeout/deadline/retry value. Before changing a value to fix a symptom ("X is slow/fails"), confirm you read the evidence that proves the cause (a log line from the failing provider/process, not a hypothesis). A timeout should measure inactivity, not total time: a process that is progressing should not be cut off.',
    );
  },
);
