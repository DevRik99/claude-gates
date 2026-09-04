// risk-level — denies an implementation delegation that does not declare its risk LEVEL
// (QUESTION|MICRO|STANDARD|HIGH-RISK), and denies a declared level that contradicts a real
// high-impact signal in the prompt (anything but HIGH-RISK).
//
// Decisions: classifying between QUESTION/MICRO/STANDARD stays the delegator's judgment;
// the gate only imposes that the declaration EXISTS and does not contradict a real,
// non-quoted high-impact signal. Over-declaring HIGH-RISK is never penalized. The LAST
// declaration governs, and contradictory declarations deny rather than guess. A documentary
// deliverable (a report on the payment flow) is not an implementation and needs no LEVEL.
// An empty `highImpactPatterns` turns the contradiction check off, not the LEVEL requirement.

import {
  DEFAULT_HIGH_IMPACT_PATTERNS,
  DEFAULT_READ_ONLY_SUBAGENTS,
  LEVELS,
  allMatches,
  buildHighImpactPattern,
  declaredLevelsOf,
  hasAmbiguousLevel,
  hasRealSensitiveMutation,
  isDocumentaryRequest,
  isExemptQuery,
  isImplementationRequest,
  isReadOnlySubagent,
  operativeLevelOf,
  promptExcerpt,
  stripQuoted,
} from '../../lib/delegation.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'risk-level';
const CONFIG_KEY = 'requireDeclaredRiskLevel';

function denyNoLevelDeclared(prompt) {
  deny(
    CONFIG_KEY,
    `This implementation delegation ("${promptExcerpt(prompt)}") does not declare its risk LEVEL. Add a ` +
      'line such as "LEVEL: STANDARD" (or QUESTION/MICRO/HIGH-RISK, whichever fits) before relaunching ' +
      'this delegation.',
  );
}

function denyAmbiguousLevel(levels) {
  deny(
    CONFIG_KEY,
    `This delegation declares multiple different risk levels (${[...new Set(levels)].join(', ')}) — ` +
      'it is not clear which one governs this task. Declare a single, unambiguous LEVEL for this ' +
      'delegation (remove any decoy/reference mention of a different level) before relaunching.',
  );
}

function denyLevelContradictsSignal(level, signal) {
  deny(
    CONFIG_KEY,
    `This delegation declares LEVEL: ${level}, but the request touches the risk signal "${signal}" near ` +
      'an implementation verb (not quoted, not the topic of a documentary deliverable) — that requires ' +
      `LEVEL: HIGH-RISK, not ${level}. Raise the declaration to HIGH-RISK before relaunching.`,
  );
}

function firstSignalText(prompt, highImpactPattern) {
  return allMatches(highImpactPattern, stripQuoted(prompt))[0]?.[0] ?? '';
}

function isExempt(toolInput, prompt, readOnlySubagents) {
  if (!prompt.trim()) return true;
  if (isReadOnlySubagent(toolInput, prompt, readOnlySubagents)) return true;
  if (isExemptQuery(prompt)) return true;
  if (!isImplementationRequest(prompt)) return true;
  return isDocumentaryRequest(prompt);
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

    if (hasAmbiguousLevel(prompt)) denyAmbiguousLevel(declaredLevelsOf(prompt));

    const level = operativeLevelOf(prompt);
    if (!level) denyNoLevelDeclared(prompt.trim());

    const highImpactPattern = buildHighImpactPattern(
      parameters.highImpactPatterns,
    );
    if (
      level !== LEVELS.HIGH_RISK &&
      hasRealSensitiveMutation(prompt, highImpactPattern)
    ) {
      denyLevelContradictsSignal(
        level,
        firstSignalText(prompt, highImpactPattern),
      );
    }
  },
);
