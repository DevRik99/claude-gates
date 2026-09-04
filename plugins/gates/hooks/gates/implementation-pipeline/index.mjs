// implementation-pipeline — denies a STANDARD/HIGH-RISK implementation delegation whose
// prompt does not declare the pipeline around the build: where the context came from
// (definition), what is verified and how (writing), and who reviews the result (reviewer).
//
// Decisions: every non-exempt subagent is a builder — an absent or unknown subagent_type is
// not a reason to skip the check, only the exempt list is. A negated mention ("do not write
// tests", "no brief.md yet") does not satisfy a stage. Work on the agent harness itself
// (.claude/, .ai/, CLAUDE.md...) is exempt; ordinary app paths such as src/hooks/ are not.

import {
  DEFAULT_EXEMPT_SUBAGENTS,
  DEMANDING_LEVELS,
  LEVELS,
  allMatches,
  isHarnessWork,
  isImplementationRequest,
  isSubagentNamedIn,
  operativeLevelOf,
} from '../../lib/delegation.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import { withUnicodeWordBoundary } from '../../lib/signals.mjs';

const GATE_ID = 'implementation-pipeline';
const CONFIG_KEY = 'requireImplementationPipeline';

// Kept for config compatibility: every non-exempt type is held to the pipeline.
const DEFAULT_BUILDER_SUBAGENTS = [
  'frontend',
  'backend',
  'worker',
  'worker-senior',
  'general-purpose',
];

const NEGATION_LOOK_BACK = 15;
const NEGATION_PATTERN = withUnicodeWordBoundary(
  "no|not|don'?t|do not|sin|never",
);

// Several small patterns instead of one long alternation: a single big regex here
// tripped the linter's regex-complexity limit. Any one matching counts as declared.
const REVIEWER_NAME_PATTERN =
  /\b(reviewer|revisor|separate review|revisi[oó]n separada|contraste|auditor)\b/i;
const REVIEWER_LABEL_PATTERN = /(review|revisi[oó]n)\s*:/i;
const REVIEWER_ACTION_EN_PATTERN =
  /\breview\s+(?:the\s+)?(?:diff|result|work)\b/i;
const REVIEWER_ACTION_ES_PATTERN =
  /\brevisa\s+(?:el\s+)?(?:diff|resultado|trabajo)\b/i;
const REVIEWER_CODE_REVIEW_PATTERN = /code.review/i;

function reviewerStageDeclared(prompt) {
  return (
    REVIEWER_NAME_PATTERN.test(prompt) ||
    REVIEWER_LABEL_PATTERN.test(prompt) ||
    REVIEWER_ACTION_EN_PATTERN.test(prompt) ||
    REVIEWER_ACTION_ES_PATTERN.test(prompt) ||
    REVIEWER_CODE_REVIEW_PATTERN.test(prompt)
  );
}

const DEFINITION_PATTERN =
  /\b(scout|reconnaissance|reconocimiento|prior exploration|explora(?:ci[oó]n)? previa|verified context|contexto verificado|asserts\.md|brief\.md)\b/i;
const WRITING_PATTERN =
  /\b(test|tests|prueba|pruebas|vitest|jest|playwright|typecheck|lint|verification|verificaci[oó]n|verification criteria)\b/i;

function isNegated(prompt, match) {
  const from = Math.max(0, match.index - NEGATION_LOOK_BACK);
  return NEGATION_PATTERN.test(prompt.slice(from, match.index));
}

function hasAffirmativeMention(prompt, pattern) {
  return allMatches(pattern, prompt).some((match) => !isNegated(prompt, match));
}

const REQUIRED_STAGES = [
  {
    id: 'definition',
    isDeclared: (prompt) => hasAffirmativeMention(prompt, DEFINITION_PATTERN),
    missing:
      'DEFINITION: does not declare where the context came from (a prior scout, read-only exploration, or an already-written asserts/brief).',
    line: 'Verified context: <path to the cited asserts/brief> — or: a prior scout ran, findings at <path>.',
  },
  {
    id: 'writing',
    isDeclared: (prompt) => hasAffirmativeMention(prompt, WRITING_PATTERN),
    missing:
      'WRITING: does not declare what is verified nor with what command. A builder does not validate its own work without a criterion written beforehand.',
    line: 'Verification: <exact command> and what is expected. Anything that cannot run is reported OMITTED, never PASS.',
  },
  {
    id: 'reviewer',
    isDeclared: reviewerStageDeclared,
    missing:
      'REVIEWER: does not declare who reviews the result. Whoever implements does not validate their own work.',
    line: 'Review: the coordinator reviews the diff and the evidence before closing — or: a read-only `revision`/`contraste` agent reviews it.',
  },
];

function isExempt(toolInput, prompt, exemptSubagents) {
  if (isSubagentNamedIn(toolInput, exemptSubagents)) return true;
  if (!DEMANDING_LEVELS.has(operativeLevelOf(prompt))) return true;
  if (!isImplementationRequest(prompt)) return true;
  return isHarnessWork(prompt);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      builderSubagents: DEFAULT_BUILDER_SUBAGENTS,
      exemptSubagents: DEFAULT_EXEMPT_SUBAGENTS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;
    if (isExempt(toolInput, prompt, parameters.exemptSubagents)) return;

    const missingStages = REQUIRED_STAGES.filter(
      (stage) => !stage.isDeclared(prompt),
    );
    if (missingStages.length === 0) return;

    const isHighRisk = operativeLevelOf(prompt) === LEVELS.HIGH_RISK;
    const details = missingStages.map((stage) => stage.missing).join(' ');
    const lines = missingStages.map((stage) => `  ${stage.line}`).join('\n');

    deny(
      CONFIG_KEY,
      `This delegation is going to build code but skips ${missingStages.length} pipeline ` +
        `stage(s). ${details} ${
          isHighRisk
            ? 'In HIGH-RISK a separate reviewer is not negotiable. '
            : ''
        }PASTE THESE LINES INTO THE PROMPT AND RELAUNCH:\n${lines}`,
    );
  },
);
