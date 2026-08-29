import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'root-cause-first';
const CONFIG_KEY = 'requireRootCauseBeforePatch';

const DEFAULT_PATCH_MARKER_PATTERNS = ['//\\s*todo:?\\s*fix\\s+later\\s+patch'];

function extractContent(toolName, toolInput) {
  if (TOOL_GROUPS.delegation.includes(toolName)) {
    return toolInput?.prompt;
  }
  return toolInput?.content ?? toolInput?.new_string;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      patchMarkerPatterns: DEFAULT_PATCH_MARKER_PATTERNS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const isWrite = TOOL_GROUPS.write.includes(toolName);
    const isDelegation = TOOL_GROUPS.delegation.includes(toolName);
    if (!isWrite && !isDelegation) return;

    const content = extractContent(toolName, toolInput);
    if (typeof content !== 'string') return;

    const patterns = parameters.patchMarkerPatterns.map(
      (source) => new RegExp(source, 'i'),
    );
    const matched = patterns.find((pattern) => pattern.test(content));
    if (!matched) return;

    deny(
      GATE_ID,
      `Content matches a patch-without-diagnosis marker (${matched.source}). Identify and fix the root cause before patching; do not defer with a "fix later" marker.`,
    );
  },
);

// Simplified vs. the source guard (guard-root-cause-first.mjs): the original
// used an auxiliary lib/embedded-content-detection.mjs module to tell real
// file content apart from a quoted example inside markdown. That module does
// not exist in this repo, so this gate matches directly against the new
// content/prompt. Distinguishing markdown quotes from real code is future
// work if false positives on quoted examples become a problem.
