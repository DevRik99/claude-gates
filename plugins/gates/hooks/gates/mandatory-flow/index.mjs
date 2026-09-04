// mandatory-flow — denies a STANDARD/HIGH-RISK implementation delegation when no live task
// exists on disk: a pointer file naming the active task slug, and a non-empty contract file
// under that task's directory. Declaring stages in prose (implementation-pipeline) is not
// the same as a task actually existing; this gate checks the disk fact.
//
// Decisions: the contract root follows the pointer — `<dir of activePointerPath>/<slug>/` —
// so a project that moves the pointer moves its tasks with it; an absolute pointer path is
// honored as-is. A slug is a directory name, never a path (traversal is rejected). An empty
// contract file is not a contract. Only the exempt list exempts a subagent type.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  DEFAULT_EXEMPT_SUBAGENTS,
  DEMANDING_LEVELS,
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

const GATE_ID = 'mandatory-flow';
const CONFIG_KEY = 'requireLiveTaskWhenImplementing';

const DEFAULT_ACTIVE_POINTER_PATH = join('.ai', 'pipeline', 'ACTIVA');

const TASK_CONTRACT_FILES = [
  'asserts.md',
  'task.json',
  'spec.md',
  'requirements.md',
  'acceptance.md',
];

function isExempt(toolInput, prompt, exemptSubagents) {
  if (isSubagentNamedIn(toolInput, exemptSubagents)) return true;
  if (!DEMANDING_LEVELS.has(operativeLevelOf(prompt))) return true;
  if (!isImplementationRequest(prompt)) return true;
  return isHarnessWork(prompt);
}

function fileExistsNonEmpty(path) {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function hasTaskContract(taskDirectory) {
  return TASK_CONTRACT_FILES.some((file) =>
    fileExistsNonEmpty(join(taskDirectory, file)),
  );
}

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

function checkLiveTask(pointerPath) {
  if (!existsSync(pointerPath)) {
    deny(
      CONFIG_KEY,
      `This delegation is going to implement, but there is no live task: ${pointerPath} ` +
        'does not exist. Start a task pointing to it before delegating, or declare ' +
        'LEVEL: QUESTION/MICRO if this is not implementation.',
    );
  }

  const slug = readSlug(pointerPath);
  if (!slug) {
    deny(
      CONFIG_KEY,
      `${pointerPath} exists but names no valid task slug (empty, or a path instead of a ` +
        'directory name). Write the task slug into it before delegating.',
    );
  }

  const taskDirectory = join(dirname(pointerPath), slug);
  if (!hasTaskContract(taskDirectory)) {
    deny(
      CONFIG_KEY,
      `The active task '${slug}' has no non-empty contract on disk: none of ` +
        `${TASK_CONTRACT_FILES.join(', ')} exists (with content) under ${taskDirectory}. ` +
        'Write ONE of those files there before implementing (a brief.md under ' +
        `.ai/features/${slug}/ satisfies sdd-specs, not this gate; if you already wrote one, ` +
        `create a short asserts.md under ${taskDirectory} referencing it).`,
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
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;
    if (isExempt(toolInput, prompt, parameters.exemptSubagents)) return;

    const root = projectRootOf(cwd) ?? cwd;
    const pointer =
      String(parameters.activePointerPath ?? '').trim() ||
      DEFAULT_ACTIVE_POINTER_PATH;
    checkLiveTask(isAbsolute(pointer) ? pointer : join(root, pointer));
  },
);
