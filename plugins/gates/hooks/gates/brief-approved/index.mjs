// brief-approved — denies a STANDARD/HIGH-RISK implementation delegation that cites a
// feature whose brief.md carries no recorded human approval. Born from a real incident: an
// ambiguous reply ("hagamos el brief") was taken as approval of a spec the assistant had
// written itself, and implementation was delegated without the user ever reading it.
//
// Decisions: a hook cannot read the chat, so "approved" means the brief's frontmatter
// carries `status: approved` AND a non-empty `approval_quote` — an artifact the assistant
// must stop and produce. The field names are fixed on purpose: a configurable key would let
// a delegation approve itself. The gate enforces ONLY when the feature directory contains
// brief.md; a feature with other contract files or none is sdd-specs' business.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { projectRootOf, stripBom } from '../../lib/config.mjs';
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
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'brief-approved';
const CONFIG_KEY = 'requireApprovedBriefBeforeImplementing';

const CATALOG_FILE_NAME = 'feature_list.json';
const FEATURES_DIRECTORY = 'features';
const BRIEF_FILE = 'brief.md';
const DEFAULT_CATALOG_LOCATIONS = [
  join('.ai', CATALOG_FILE_NAME),
  CATALOG_FILE_NAME,
];

const FRONTMATTER_PATTERN = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/;
const APPROVED_STATUS_PATTERN = /^status:[ \t]*["']?approved["']?[ \t]*$/im;
const APPROVAL_QUOTE_PATTERN = /^approval_quote:(.*)$/im;

function resolveFrom(root, path) {
  return isAbsolute(path) ? path : join(root, path);
}

function findCatalog(root, catalogLocations) {
  for (const relative of catalogLocations) {
    const path = resolveFrom(root, relative);
    if (existsSync(path)) return path;
  }
  return null;
}

function contractTreeRootFor(root, catalogPath) {
  const candidates = catalogPath
    ? [join(dirname(catalogPath), FEATURES_DIRECTORY)]
    : [];
  candidates.push(
    join(root, '.ai', FEATURES_DIRECTORY),
    join(root, FEATURES_DIRECTORY),
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function briefPathFor(treeRoot, featureName) {
  const path = join(treeRoot, featureName, BRIEF_FILE);
  return existsSync(path) ? path : null;
}

function isApproved(briefPath) {
  let content;
  try {
    content = stripBom(readFileSync(briefPath, 'utf8'));
  } catch {
    return false;
  }
  const frontmatter = FRONTMATTER_PATTERN.exec(content)?.groups?.body;
  if (!frontmatter) return false;
  if (!APPROVED_STATUS_PATTERN.test(frontmatter)) return false;
  const quote = APPROVAL_QUOTE_PATTERN.exec(frontmatter)?.[1] ?? '';
  return (
    quote
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim().length > 0
  );
}

function isExemptDelegation(toolInput, prompt, exemptSubagents) {
  if (isSubagentNamedIn(toolInput, exemptSubagents)) return true;
  if (!DEMANDING_LEVELS.has(operativeLevelOf(prompt))) return true;
  return !isImplementationRequest(prompt);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      catalogLocations: DEFAULT_CATALOG_LOCATIONS,
      exemptSubagents: DEFAULT_EXEMPT_SUBAGENTS,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;
    if (isExemptDelegation(toolInput, prompt, parameters.exemptSubagents))
      return;

    const citedFeatures = featureNamesCitedIn(prompt);
    if (citedFeatures.length === 0) return;

    const root = projectRootOf(cwd) ?? cwd;
    const catalogLocations =
      parameters.catalogLocations.length > 0
        ? parameters.catalogLocations
        : DEFAULT_CATALOG_LOCATIONS;
    const treeRoot = contractTreeRootFor(
      root,
      findCatalog(root, catalogLocations),
    );
    if (!treeRoot) return;

    const unapproved = citedFeatures
      .map((feature) => ({
        feature,
        briefPath: briefPathFor(treeRoot, feature),
      }))
      .filter(({ briefPath }) => briefPath && !isApproved(briefPath));
    if (unapproved.length === 0) return;

    const fileList = unapproved
      .map(({ feature, briefPath }) => `${feature} -> ${briefPath}`)
      .join('\n  ');
    deny(
      CONFIG_KEY,
      `This implementation delegation cites feature(s) whose brief has no recorded approval:\n  ${fileList}\n` +
        'Paste the FULL brief into the chat, get an explicit confirmation from the user ' +
        '(not a vague "ok"/"sigamos" — an actual sentence confirming they read it), ' +
        'then add this frontmatter to the TOP of that exact brief.md before relaunching ' +
        '(no filesystem exploration needed — the path above is the file to edit):\n' +
        '---\nstatus: approved\napproved_at: <ISO timestamp>\n' +
        'approval_quote: "<the user\'s own confirming words>"\n---',
    );
  },
);
