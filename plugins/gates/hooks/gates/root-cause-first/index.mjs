// root-cause-first — a "patch it later" marker without a diagnosis in the same content is
// denied. Tests and docs are skipped: a test names the marker it checks and a doc describes
// the practice; neither defers a fix.

import {
  runGate,
  deny,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
  delegationPromptOf,
  compileRegexList,
} from '../../lib/hook-io.mjs';
import { isTestPath } from '../../lib/tools.mjs';

const GATE_ID = 'root-cause-first';
const CONFIG_KEY = 'requireRootCauseBeforePatch';

const DEFAULT_PATCH_MARKER_PATTERNS = [
  'todo:? fix later',
  'fixme:? patch',
  'hotfix',
  'quick fix',
  'workaround',
  'temporary (patch|fix)',
  'parche temporal',
  'arreglo r[aá]pido',
  'apa[ñn]o',
];

const DIAGNOSIS_PATTERN =
  /root cause:|causa ra[ií]z:|diagnosis:|diagn[oó]stico:/i;
const DOCUMENT_EXTENSION_PATTERN = /\.(?:md|mdx|txt)$/i;

function textToScan(toolName, toolInput) {
  if (toolInGroups(toolName, ['delegation']))
    return delegationPromptOf(toolInput);
  const path = writtenPathOf(toolInput);
  if (isTestPath(path) || DOCUMENT_EXTENSION_PATTERN.test(path)) return '';
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
    if (DIAGNOSIS_PATTERN.test(content)) return;

    const { patterns } = compileRegexList(parameters.patchMarkerPatterns);
    const matched = patterns
      .map((pattern) => pattern.exec(content))
      .find((match) => match !== null);
    if (!matched) return;

    deny(
      CONFIG_KEY,
      `Content contains a patch-without-diagnosis marker ("${matched[0]}"). Identify the ` +
        'root cause before patching: state it in the same content with a line starting ' +
        '"root cause:" (or "causa raíz:", "diagnosis:", "diagnóstico:"), then retry the ' +
        'same write. To change the markers, set patchMarkerPatterns for ' +
        `${CONFIG_KEY} in .ai/config.json.`,
    );
  },
);
