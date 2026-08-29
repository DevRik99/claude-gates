// implementation-pipeline — denies a delegation that sends a builder subagent straight
// to writing code without the prompt declaring the pipeline stages around it:
// definition (where the context came from), writing's own verification plan, and a
// separate reviewer for validation/QA/closure. Migrated from
// ~/.claude/hooks/guard-pipeline-de-implementacion.mjs.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   builderSubagents   subagent types that count as builders — the ones this gate
//                       holds to the pipeline. Replaces the built-in list wholesale.
//   exemptSubagents     subagent types exempt outright: read-only pipeline stages that
//                       cannot be required to declare a pipeline around themselves.
//                       Replaces the built-in list wholesale.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.
//
// ── Off by default, and quiet outside its narrow trigger ───────────────────────────
// This gate only evaluates a delegation whose prompt declares a STANDARD/HIGH-RISK
// level, uses an implementation verb, targets a builder subagent, and is not about the
// harness itself. A prompt that only describes work, or that is read-only/exploratory,
// never reaches the check.

import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'implementation-pipeline';
const CONFIG_KEY = 'requireImplementationPipeline';

const DELEGATION_TOOLS = new Set(TOOL_GROUPS.delegation);

const DEFAULT_BUILDER_SUBAGENTS = [
  'frontend',
  'backend',
  'worker',
  'worker-senior',
  'general-purpose',
];

const DEFAULT_EXEMPT_SUBAGENTS = [
  'scout',
  'explore',
  'plan',
  'revision',
  'contraste',
  'test-planner',
  'qa',
  'ui',
  'ux',
];

function withWordBoundary(alternation) {
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])(?:${alternation})(?:[^\\p{L}\\p{N}_]|$)`,
    'iu',
  );
}

const IMPLEMENTATION_VERBS = withWordBoundary(
  'implementa|implementar|implement(á|é)|agreg(a|á)|agregar|añad(e|í)|añadir|cre(a|á)|crear|' +
    'arregl(a|á)|arreglar|cambi(a|á)|cambiar|migr(a|á)|migrar|' +
    'corrige|corregir|correg(í|ir)|constru(ye|í)|construir|modific(a|á)|modificar|' +
    'refactoriz(a|á)|refactorizar|elimin(a|á)|eliminar|reescrib(e|í)|reescribir|desplieg(a|á)|desplegar|' +
    'escrib(í|e)|escribir|implement\\w*|writ(?:e|ing)|creat\\w*|fix\\w*|build\\w*|refactor\\w*|migrat\\w*|' +
    'add\\w*|remov\\w*|delet\\w*|modify|modifies|modifying|rewrit\\w*',
);

/** Declared LEVEL near the word "level"/"classification" in Spanish or English, matching
 * the plugin-wide convention (see risk-level.mjs). */
const DEMANDING_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(STANDARD|HIGH-RISK)\b/iu;
const EXEMPT_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(QUESTION|MICRO)\b/iu;
const HIGH_RISK_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\bHIGH-RISK\b/iu;

const HARNESS_PATTERN =
  /(\.claude[\\/]|hooks[\\/]|plugins[\\/]gates|settings\.json|[\\/]agents[\\/]\w|[\\/]rules[\\/]\w|[\\/]skills[\\/]\w)/i;

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

/** The three pipeline stages this gate requires be declared, in this order. */
const REQUIRED_STAGES = [
  {
    id: 'definition',
    isDeclared: (prompt) => DEFINITION_PATTERN.test(prompt),
    missing:
      'DEFINITION: does not declare where the context came from (a prior scout, read-only exploration, or an already-written asserts/brief).',
    line: 'Verified context: <path to the cited asserts/brief> — or: a prior scout ran, findings at <path>.',
  },
  {
    id: 'writing',
    isDeclared: (prompt) => WRITING_PATTERN.test(prompt),
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

function isExempt(toolInput, prompt, builderSubagents, exemptSubagents) {
  const subagentType = String(
    toolInput.subagent_type ?? toolInput.subagentType ?? '',
  ).toLowerCase();
  if (exemptSubagents.includes(subagentType)) return true;
  // An unknown type is not assumed to be a builder: the safe side here is not to
  // invent requirements for agents this gate cannot classify.
  if (subagentType && !builderSubagents.includes(subagentType)) return true;
  if (EXEMPT_LEVEL_PATTERN.test(prompt)) return true;
  if (!DEMANDING_LEVEL_PATTERN.test(prompt)) return true;
  if (!IMPLEMENTATION_VERBS.test(prompt)) return true;
  if (HARNESS_PATTERN.test(prompt)) return true;
  return false;
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
    if (!DELEGATION_TOOLS.has(toolName)) return;

    const prompt = String(
      toolInput.prompt ?? toolInput.Prompt ?? toolInput.task ?? '',
    );
    if (!prompt.trim()) return;

    const builderSubagents =
      parameters.builderSubagents ?? DEFAULT_BUILDER_SUBAGENTS;
    const exemptSubagents =
      parameters.exemptSubagents ?? DEFAULT_EXEMPT_SUBAGENTS;
    if (isExempt(toolInput, prompt, builderSubagents, exemptSubagents)) return;

    const missingStages = REQUIRED_STAGES.filter(
      (stage) => !stage.isDeclared(prompt),
    );
    if (missingStages.length === 0) return;

    const isHighRisk = HIGH_RISK_PATTERN.test(prompt);
    const details = missingStages.map((stage) => stage.missing).join(' ');
    const lines = missingStages.map((stage) => `  ${stage.line}`).join('\n');

    deny(
      GATE_ID,
      `This delegation is going to build code but skips ${missingStages.length} pipeline ` +
        `stage(s). ${details} ${
          isHighRisk
            ? 'In HIGH-RISK a separate reviewer is not negotiable. '
            : ''
        }PASTE THESE LINES INTO THE PROMPT AND RELAUNCH:\n${lines}`,
    );
  },
);
