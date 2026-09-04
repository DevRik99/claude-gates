// sdd-specs — denies implementation (a catalog write moving a feature past `spec_ready`,
// or a STANDARD/HIGH-RISK implementation delegation citing a feature) when the feature has
// no non-empty contract on disk (requirements/design/tasks or brief/asserts).
//
// Decisions: the gate is inert until a catalog exists at one of `catalogLocations` — a
// project that never adopted the spec-driven harness must not be held to it. A delegation
// citing several features is denied when ANY of them lacks a contract. The LAST declared
// LEVEL governs, so a decoy MICRO before HIGH-RISK exempts nothing.

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  DEFAULT_EXEMPT_SUBAGENTS,
  DEMANDING_LEVELS,
  featureNamesCitedIn,
  isImplementationRequest,
  isSubagentNamedIn,
  operativeLevelOf,
} from '../../lib/delegation.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'sdd-specs';
const CONFIG_KEY = 'requireSpecBeforeImplementing';

const CATALOG_FILE_NAME = 'feature_list.json';
const FEATURES_DIRECTORY = 'features';

const DEFAULT_CATALOG_LOCATIONS = [
  join('.ai', CATALOG_FILE_NAME),
  CATALOG_FILE_NAME,
];

const ADVANCED_STATUSES = new Set(['spec_ready', 'in_progress', 'done']);

const CONTRACT_FILES = [
  'requirements.md',
  'design.md',
  'tasks.md',
  'brief.md',
  'asserts.md',
];

function fileExistsNonEmpty(path) {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function resolveFrom(root, path) {
  return isAbsolute(path) ? path : join(root, path);
}

function findCatalog(root, catalogLocations, writtenPath) {
  const roots = [root];
  // A monorepo subpackage keeps its own catalog next to the file being written.
  if (writtenPath) roots.push(dirname(resolveFrom(root, writtenPath)));
  for (const base of roots) {
    for (const relative of catalogLocations) {
      const path = resolveFrom(base, relative);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

function contractTreeRootFor(root, catalogPath) {
  const candidates = [
    join(dirname(catalogPath), FEATURES_DIRECTORY),
    join(root, '.ai', FEATURES_DIRECTORY),
    join(root, FEATURES_DIRECTORY),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function contractExistsFor(treeRoot, featureName) {
  if (!treeRoot) return false;
  const featureDirectory = join(treeRoot, featureName);
  if (!existsSync(featureDirectory)) return false;
  return CONTRACT_FILES.some((file) =>
    fileExistsNonEmpty(join(featureDirectory, file)),
  );
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function denyIfAdvancedFeatureLacksContract(features, treeRoot, fallbackRoot) {
  for (const feature of features) {
    if (!ADVANCED_STATUSES.has(feature?.status)) continue;
    if (!feature?.name) {
      deny(
        CONFIG_KEY,
        `A feature entry has status '${feature.status}' but no 'name' field: ` +
          `${JSON.stringify(feature)}. Every feature needs a 'name' so its contract tree ` +
          '(.ai/features/<name>/) can be located — add it before writing this status.',
      );
    }
    if (contractExistsFor(treeRoot, feature.name)) continue;
    const featureDirectory = join(treeRoot ?? fallbackRoot, feature.name);
    deny(
      CONFIG_KEY,
      `Feature '${feature.name}' is set to '${feature.status}' but has no non-empty ` +
        `contract on disk. Write ONE of these files under ${featureDirectory}/ (any one ` +
        `is enough): ${CONTRACT_FILES.join(', ')}.`,
    );
  }
}

function targetsCatalog(target, catalogLocations) {
  const name = basename(target);
  return catalogLocations.some((location) => basename(location) === name);
}

function checkCatalogWrite(
  toolInput,
  catalogLocations,
  treeRoot,
  fallbackRoot,
) {
  const target = writtenPathOf(toolInput);
  if (!target || !targetsCatalog(target, catalogLocations)) return;

  const parsed = parseJsonOrNull(writtenContentOf(toolInput));
  if (parsed === null) {
    // Fail closed: a status transition hidden behind malformed JSON must not slip through.
    deny(
      CONFIG_KEY,
      `The write to ${basename(target)} does not parse as JSON (JSON.parse threw). This ` +
        'is a syntax problem in the content being written, not a missing-field one — check ' +
        'for a trailing comma, unquoted key, or unclosed bracket in what you are about to ' +
        'write. No filesystem exploration needed; the payload itself is the thing to fix.',
    );
  }
  const features = Array.isArray(parsed?.features) ? parsed.features : [];
  denyIfAdvancedFeatureLacksContract(features, treeRoot, fallbackRoot);
}

function isExemptDelegation(toolInput, prompt, exemptSubagents) {
  if (isSubagentNamedIn(toolInput, exemptSubagents)) return true;
  if (!DEMANDING_LEVELS.has(operativeLevelOf(prompt))) return true;
  return !isImplementationRequest(prompt);
}

function checkDelegation(toolInput, treeRoot, fallbackRoot, exemptSubagents) {
  const prompt = delegationPromptOf(toolInput);
  if (!prompt.trim()) return;
  if (isExemptDelegation(toolInput, prompt, exemptSubagents)) return;

  const citedFeatures = featureNamesCitedIn(prompt);
  if (citedFeatures.length === 0) return;

  const missing = citedFeatures.filter(
    (feature) => !contractExistsFor(treeRoot, feature),
  );
  if (missing.length === 0) return;

  const root = treeRoot ?? fallbackRoot;
  const fileList = missing
    .map((feature) => `${feature} -> ${join(root, feature)}/`)
    .join('\n  ');
  deny(
    CONFIG_KEY,
    `This implementation delegation cites feature(s) with no contract on disk:\n  ${fileList}\n` +
      `Write ONE of these files in each directory above (any one is enough): ` +
      `${CONTRACT_FILES.join(', ')}. Then relaunch.`,
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      catalogLocations: DEFAULT_CATALOG_LOCATIONS,
      exemptSubagents: DEFAULT_EXEMPT_SUBAGENTS,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    const isWrite = toolInGroups(toolName, ['write']);
    const isDelegation = toolInGroups(toolName, ['delegation']);
    if (!isWrite && !isDelegation) return;

    const root = projectRootOf(cwd) ?? cwd;
    const catalogLocations =
      parameters.catalogLocations.length > 0
        ? parameters.catalogLocations
        : DEFAULT_CATALOG_LOCATIONS;
    const catalogPath = findCatalog(
      root,
      catalogLocations,
      isWrite ? writtenPathOf(toolInput) : null,
    );
    if (!catalogPath) return;

    const treeRoot = contractTreeRootFor(root, catalogPath);
    const fallbackRoot = join(root, '.ai', FEATURES_DIRECTORY);

    if (isWrite)
      checkCatalogWrite(toolInput, catalogLocations, treeRoot, fallbackRoot);
    if (isDelegation)
      checkDelegation(
        toolInput,
        treeRoot,
        fallbackRoot,
        parameters.exemptSubagents,
      );
  },
);
