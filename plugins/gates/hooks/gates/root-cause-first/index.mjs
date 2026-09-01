import {
  runGate,
  deny,
  toolInGroups,
  writtenContentOf,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'root-cause-first';
const CONFIG_KEY = 'requireRootCauseBeforePatch';

const DEFAULT_PATCH_MARKER_PATTERNS = ['//\\s*todo:?\\s*fix\\s+later\\s+patch'];

// The text to scan: a delegation's brief, or the content a write puts on disk. writtenContentOf
// covers every native and MCP write shape (Write's content, Edit's new_string, NotebookEdit's
// new_source, replace_file_content's new_content) — the old reader missed new_source, so a
// deferral marker written via NotebookEdit was never caught by this DENY gate.
function textToScan(toolName, toolInput) {
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
      patchMarkerPatterns: DEFAULT_PATCH_MARKER_PATTERNS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['write', 'delegation'])) return;

    const content = textToScan(toolName, toolInput);
    if (!content) return;

    const patterns = parameters.patchMarkerPatterns.map(
      (source) => new RegExp(source, 'i'),
    );
    const matched = patterns.find((pattern) => pattern.test(content));
    if (!matched) return;

    deny(
      CONFIG_KEY,
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
