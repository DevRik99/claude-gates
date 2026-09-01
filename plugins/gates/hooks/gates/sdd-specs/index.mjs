// sdd-specs — denies implementation (a write to the catalog moving a feature past
// `spec_ready`, or a delegation prompt that implements) when the feature/task it targets
// has no non-empty contract on disk (requirements/design/tasks or brief/asserts).
// Migrated from ~/.claude/hooks/guard-sdd-specs.mjs.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   catalogLocations   paths (relative to the project root) searched for the feature
//                       catalog. Replaces the built-in list wholesale.
//   exemptSubagents     subagent types exempt from the spec requirement (read-only
//                       stages of the pipeline that cannot require a contract of
//                       themselves). Replaces the built-in list wholesale.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.
//
// ── Auto-off when there is no SDD harness ───────────────────────────────────────────
// This gate only acts once a catalog is found at one of `catalogLocations` (or the
// project's own `.ai/config.json` declares adoption). A project that never adopted the
// spec-driven harness has no catalog and no declared adoption, so every check below is
// skipped and the write/delegation is allowed — imposing phases on a project that never
// asked for them is the false positive that gets a gate disabled.
//
// ── Two surfaces inspected ───────────────────────────────────────────────────────────
// A write to the catalog is checked against the catalog's own declared statuses: a
// feature marked `spec_ready`/`in_progress`/`done` needs its contract tree in place. A
// delegation prompt is checked when it declares a STANDARD/HIGH-RISK level and an
// implementation verb: the contract tree must have non-empty requirements/design/tasks
// (or brief/asserts) for the feature it targets.

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const DEFAULT_CATALOG_LOCATIONS = [
  join('.ai', CATALOG_FILE_NAME),
  CATALOG_FILE_NAME,
];

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

const ADVANCED_STATUSES = new Set(['spec_ready', 'in_progress', 'done']);

/** Files that count as a feature's contract; at least one must be non-empty. */
const CONTRACT_FILES = [
  'requirements.md',
  'design.md',
  'tasks.md',
  'brief.md',
  'asserts.md',
];

function withWordBoundary(alternation) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(${alternation})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

const IMPLEMENTATION_VERBS = withWordBoundary(
  'implementa|implementar|implement(á|é)|agreg(a|á)|agregar|añad(e|í)|añadir|cre(a|á)|crear|' +
    'arregl(a|á)|arreglar|cambi(a|á)|cambiar|migr(a|á)|migrar|' +
    'corrige|corregir|correg(í|ir)|constru(ye|í)|construir|modific(a|á)|modificar|' +
    'refactoriz(a|á)|refactorizar|elimin(a|á)|eliminar|reescrib(e|í)|reescribir|desplieg(a|á)|desplegar|' +
    'escrib(í|e)|escribir|implement\\w*|writ(e|ing)|creat\\w*|fix\\w*|build\\w*|refactor\\w*|migrat\\w*|' +
    'add\\w*|remov\\w*|delet\\w*|modify|modifies|modifying|rewrit\\w*',
);

/** Declared LEVEL near the word "level"/"classification" in Spanish or English, matching
 * the plugin-wide convention (see risk-level.mjs). */
const DEMANDING_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(STANDARD|HIGH-RISK)\b/iu;
const EXEMPT_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(QUESTION|MICRO)\b/iu;

function fileExistsNonEmpty(path) {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function findCatalog(catalogLocations, writtenPath) {
  const roots = [process.cwd()];
  // A write can target a catalog that lives elsewhere than cwd (a monorepo subpackage's
  // own .ai/feature_list.json): also resolve catalogLocations relative to the directory
  // of the file actually being written, not only the process cwd.
  if (writtenPath) roots.push(dirname(writtenPath));
  for (const root of roots) {
    for (const relative of catalogLocations) {
      const path = join(root, relative);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** Discovers the contract tree root next to wherever the catalog lives, or `.ai/features`. */
function contractTreeRootFor(catalogPath) {
  const candidates = catalogPath
    ? [join(dirname(catalogPath), 'features')]
    : [];
  candidates.push(join(process.cwd(), '.ai', 'features'));
  candidates.push(join(process.cwd(), 'features'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
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

/** Denies the single first advanced-status feature in the new catalog content that has
 * no contract on disk, or does nothing when every advanced feature has one. A feature
 * object missing its `name` field is denied too (not silently skipped) — it is malformed
 * catalog data, not a feature this gate has decided has no obligations. */
function denyIfAdvancedFeatureLacksContract(features, treeRoot) {
  for (const feature of features) {
    if (!ADVANCED_STATUSES.has(feature?.status)) continue;
    if (!feature?.name) {
      deny(
        CONFIG_KEY,
        `A feature entry has status '${feature.status}' but no 'name' field: ` +
          `${JSON.stringify(feature)}. Every feature needs a 'name' so its contract tree ` +
          '(.ai/features/<name>/) can be located — add it before writing this status.',
      );
      continue;
    }
    if (contractExistsFor(treeRoot, feature.name)) continue;
    const featureDirectory = join(
      treeRoot ?? join(process.cwd(), '.ai', 'features'),
      feature.name,
    );
    deny(
      CONFIG_KEY,
      `Feature '${feature.name}' is set to '${feature.status}' but has no non-empty ` +
        `contract on disk. Write ONE of these files under ${featureDirectory}/ (any one ` +
        `is enough): ${CONTRACT_FILES.join(', ')}.`,
    );
  }
}

function checkCatalogWrite(toolInput, catalogPath, treeRoot) {
  const target = writtenPathOf(toolInput);
  if (!catalogPath || !target.includes(CATALOG_FILE_NAME)) return;

  const rawContent = writtenContentOf(toolInput);
  const parsed = parseJsonOrNull(rawContent);
  if (parsed === null) {
    // Fail-closed, not fail-open: a write whose content does not parse as JSON but
    // still targets the catalog is suspicious on its own -- a spec_ready/done transition
    // hidden behind a malformed payload must not be silently allowed through.
    deny(
      CONFIG_KEY,
      `The write to ${CATALOG_FILE_NAME} does not parse as JSON (JSON.parse threw). This ` +
        'is a syntax problem in the content being written, not a missing-field one — check ' +
        'for a trailing comma, unquoted key, or unclosed bracket in what you are about to ' +
        'write. No filesystem exploration needed; the payload itself is the thing to fix.',
    );
  }
  const features = Array.isArray(parsed?.features) ? parsed.features : [];
  denyIfAdvancedFeatureLacksContract(features, treeRoot);
}

function isExemptDelegation(toolInput, prompt, exemptSubagents) {
  const subagentType = String(
    toolInput.subagent_type ?? toolInput.subagentType ?? '',
  ).toLowerCase();
  if (exemptSubagents.includes(subagentType)) return true;
  if (EXEMPT_LEVEL_PATTERN.test(prompt)) return true;
  if (!DEMANDING_LEVEL_PATTERN.test(prompt)) return true;
  if (!IMPLEMENTATION_VERBS.test(prompt)) return true;
  return false;
}

function featureNamesCitedIn(prompt) {
  const pattern = /\.(?:ai)[\\/]features[\\/]([\w.@-]+)/gi;
  const names = [];
  let match;
  while ((match = pattern.exec(prompt)) !== null) names.push(match[1]);
  return names;
}

function checkDelegation(toolInput, treeRoot, exemptSubagents) {
  const prompt = delegationPromptOf(toolInput);
  if (!prompt.trim()) return;
  if (isExemptDelegation(toolInput, prompt, exemptSubagents)) return;

  const citedFeatures = featureNamesCitedIn(prompt);
  if (citedFeatures.length === 0) return; // no citation: nothing this gate can check

  const missing = citedFeatures.filter(
    (feature) => !contractExistsFor(treeRoot, feature),
  );
  if (missing.length === citedFeatures.length) {
    const root = treeRoot ?? join(process.cwd(), '.ai', 'features');
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
  ({ toolName, toolInput, parameters }) => {
    const isWrite = toolInGroups(toolName, ['write']);
    const isDelegation = toolInGroups(toolName, ['delegation']);
    if (!isWrite && !isDelegation) return;

    const catalogLocations =
      parameters.catalogLocations ?? DEFAULT_CATALOG_LOCATIONS;
    const catalogPath = findCatalog(
      catalogLocations,
      isWrite ? writtenPathOf(toolInput) : null,
    );
    if (!catalogPath) return; // no SDD harness adopted: stay silent

    const treeRoot = contractTreeRootFor(catalogPath);

    if (isWrite) checkCatalogWrite(toolInput, catalogPath, treeRoot);
    if (isDelegation) {
      const exemptSubagents =
        parameters.exemptSubagents ?? DEFAULT_EXEMPT_SUBAGENTS;
      checkDelegation(toolInput, treeRoot, exemptSubagents);
    }
  },
);
