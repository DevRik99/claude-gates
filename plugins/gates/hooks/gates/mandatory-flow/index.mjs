// mandatory-flow — denies an implementation delegation when there is no live task
// pointer on disk backed by a contract file. Declaring pipeline stages in prose (what
// implementation-pipeline.mjs checks) is not the same as a live task actually existing
// on disk; this gate checks the disk fact, not the prompt's wording. Migrated from
// ~/.claude/hooks/guard-flujo-obligatorio.mjs.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   activePointerPath   path (relative to the project root) to the file naming the
//                        active task/pipeline slug.
//   exemptSubagents      subagent types exempt outright (read-only pipeline stages).
//                        Replaces the built-in list wholesale.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.
//
// ── Off by default, and quiet outside its narrow trigger ───────────────────────────
// Only STANDARD/HIGH-RISK implementation delegations, on non-exempt subagents, not
// about the harness itself, reach the disk check.

import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'mandatory-flow';
const CONFIG_KEY = 'requireLiveTaskWhenImplementing';

const DEFAULT_ACTIVE_POINTER_PATH = join('.ai', 'pipeline', 'ACTIVA');

const DEFAULT_EXEMPT_SUBAGENTS = [
  'explore',
  'plan',
  'scout',
  'revision',
  'contraste',
  'test-planner',
  'qa',
  'ui',
  'ux',
];

/** Contract files that count as evidence a task's contract exists on disk. */
const TASK_CONTRACT_FILES = [
  'asserts.md',
  'task.json',
  'spec.md',
  'requirements.md',
  'acceptance.md',
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

const HARNESS_PATTERN =
  /(\.claude[\\/]|hooks[\\/]|plugins[\\/]gates|settings\.json|[\\/]agents[\\/]\w|[\\/]rules[\\/]\w|[\\/]skills[\\/]\w)/i;

function isExempt(toolInput, prompt, exemptSubagents) {
  const subagentType = String(
    toolInput.subagent_type ?? toolInput.subagentType ?? '',
  ).toLowerCase();
  if (exemptSubagents.includes(subagentType)) return true;
  if (EXEMPT_LEVEL_PATTERN.test(prompt)) return true;
  if (!DEMANDING_LEVEL_PATTERN.test(prompt)) return true;
  if (!IMPLEMENTATION_VERBS.test(prompt)) return true;
  if (HARNESS_PATTERN.test(prompt)) return true;
  return false;
}

function hasTaskContract(taskDirectory) {
  return TASK_CONTRACT_FILES.some((file) => {
    try {
      return existsSync(join(taskDirectory, file));
    } catch {
      return false;
    }
  });
}

/** The pointer file's trimmed content, or '' when it cannot be read or the slug
 * attempts path traversal. A slug is a directory name, not a path: rejecting any
 * segment separator or '..' closes off `join(cwd, '.ai', 'pipeline', slug)` escaping
 * that directory to accept an unrelated file elsewhere on disk as the task contract. */
function readSlug(pointerPath) {
  let raw;
  try {
    raw = readFileSync(pointerPath, 'utf8').trim();
  } catch {
    return '';
  }
  if (!raw) return '';
  const normalized = normalize(raw);
  const hasTraversal = normalized
    .split(/[\\/]/)
    .some((segment) => segment === '..' || segment === '.');
  if (hasTraversal || normalized.includes(sep) || normalized.includes('/')) {
    return '';
  }
  return normalized;
}

/** Denies for whichever of the three live-task facts is missing, or does nothing. */
function checkLiveTask(pointerPath) {
  if (!existsSync(pointerPath)) {
    deny(
      GATE_ID,
      `This delegation is going to implement, but there is no live task: ${pointerPath} ` +
        'does not exist. Start a task pointing to it before delegating, or declare ' +
        'LEVEL: QUESTION/MICRO if this is not implementation.',
    );
  }

  const slug = readSlug(pointerPath);
  if (!slug) {
    deny(
      GATE_ID,
      `${pointerPath} exists but is empty. An active-task pointer with no slug is not ` +
        'a live task. Write the task slug into it before delegating.',
    );
  }

  const taskDirectory = join(process.cwd(), '.ai', 'pipeline', slug);
  if (!hasTaskContract(taskDirectory)) {
    deny(
      GATE_ID,
      `The active task '${slug}' has no contract on disk: none of ` +
        `${TASK_CONTRACT_FILES.join(', ')} exists under ${taskDirectory}. ` +
        'Write the contract before implementing.',
    );
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      activePointerPath: DEFAULT_ACTIVE_POINTER_PATH,
      exemptSubagents: DEFAULT_EXEMPT_SUBAGENTS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;

    const exemptSubagents =
      parameters.exemptSubagents ?? DEFAULT_EXEMPT_SUBAGENTS;
    if (isExempt(toolInput, prompt, exemptSubagents)) return;

    const activePointerPath = String(
      parameters.activePointerPath ?? DEFAULT_ACTIVE_POINTER_PATH,
    );
    checkLiveTask(join(process.cwd(), activePointerPath));
  },
);
