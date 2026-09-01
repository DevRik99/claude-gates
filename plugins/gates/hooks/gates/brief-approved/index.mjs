// brief-approved — denies an implementation delegation (STANDARD/HIGH-RISK, an
// implementation verb) that targets a feature whose brief/spec has no recorded human
// approval. Migrated from a real incident: the assistant took an ambiguous user reply
// ("hagamos el brief") as approval of a spec it had already written, delegated
// implementation straight away, and never pasted the full brief into the chat for the
// user to confirm line by line. `sdd-specs` already blocks implementing a feature with
// NO contract at all; this gate blocks implementing a feature whose contract exists but
// was never actually approved by the user — a distinct failure this incident exposed.
//
// ── What "approved" means here (deliberately narrow) ────────────────────────────────
// A hook cannot read the chat, so it cannot verify the assistant actually pasted the
// full brief and that the user actually read it. What IS checkable: the brief file
// itself carries a frontmatter block written ONLY once that confirmation happened —
//   ---
//   status: approved
//   approved_at: <ISO timestamp>
//   approval_quote: "<user's own words>"
//   ---
// The gate does not (cannot) verify the quote is genuine; it verifies the field exists
// and is non-empty, which at minimum forces the assistant to stop and produce a
// specific artifact instead of silently inferring consent from a vague reply.
//
// ── Auto-off when there is no brief to approve ──────────────────────────────────────
// Same discovery as sdd-specs: only fires once a feature contract tree exists under
// .ai/features/<name>/ (or the configured catalog's sibling `features` dir) AND that
// feature has a brief.md/asserts.md file. A project with no such file for the cited
// feature is out of this gate's scope (sdd-specs already denies that case).
//
// ── What is NOT configurable (base, non-negotiable) ─────────────────────────────────
// The frontmatter field names (status/approved_at/approval_quote) are fixed, not a
// project param — a configurable field name would let a delegation "approve" itself by
// pointing the gate at whatever key it just wrote.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  runGate,
  deny,
  toolInGroups,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'brief-approved';
const CONFIG_KEY = 'requireApprovedBriefBeforeImplementing';

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

/** Files that count as a feature's contract; the first one found on disk is the one
 * checked for approval (mirrors sdd-specs' CONTRACT_FILES precedence). */
const CONTRACT_FILES = [
  'brief.md',
  'requirements.md',
  'design.md',
  'tasks.md',
  'asserts.md',
];

const APPROVED_FRONTMATTER_PATTERN = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/;
const APPROVED_STATUS_PATTERN = /^status:[ \t]*approved[ \t]*$/im;
const APPROVAL_QUOTE_PATTERN = /^approval_quote:[ \t]*(\S.*)$/im;

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

const DEMANDING_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(STANDARD|HIGH-RISK)\b/iu;
const EXEMPT_LEVEL_PATTERN =
  /(nivel|level|clasificaci[oó]n|classification)[^\n]{0,25}?\b(QUESTION|MICRO)\b/iu;

function findCatalog(catalogLocations) {
  for (const relative of catalogLocations) {
    const path = join(process.cwd(), relative);
    if (existsSync(path)) return path;
  }
  return null;
}

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

/** The first existing contract file's path for a feature, or null if none exists. */
function contractFileFor(treeRoot, featureName) {
  if (!treeRoot) return null;
  const featureDirectory = join(treeRoot, featureName);
  if (!existsSync(featureDirectory)) return null;
  for (const file of CONTRACT_FILES) {
    const path = join(featureDirectory, file);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Whether a contract file's frontmatter records a real approval: `status: approved`
 * plus a non-empty `approval_quote`. Both must be present — status alone is a label
 * the assistant could set on itself with no evidence a quote was ever collected. */
function isApproved(contractPath) {
  let content;
  try {
    content = readFileSync(contractPath, 'utf8');
  } catch {
    return false;
  }
  const frontmatter = APPROVED_FRONTMATTER_PATTERN.exec(content)?.groups?.body;
  if (!frontmatter) return false;
  if (!APPROVED_STATUS_PATTERN.test(frontmatter)) return false;
  const quoteMatch = APPROVAL_QUOTE_PATTERN.exec(frontmatter);
  const quote = quoteMatch?.[1]?.replace(/^["']|["']$/g, '').trim();
  return Boolean(quote);
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
    if (!toolInGroups(toolName, ['delegation'])) return;

    const prompt = delegationPromptOf(toolInput);
    if (!prompt.trim()) return;

    const exemptSubagents =
      parameters.exemptSubagents ?? DEFAULT_EXEMPT_SUBAGENTS;
    if (isExemptDelegation(toolInput, prompt, exemptSubagents)) return;

    const citedFeatures = featureNamesCitedIn(prompt);
    if (citedFeatures.length === 0) return; // no citation: nothing this gate can check

    const catalogLocations =
      parameters.catalogLocations ?? DEFAULT_CATALOG_LOCATIONS;
    const catalogPath = findCatalog(catalogLocations);
    const treeRoot = contractTreeRootFor(catalogPath);
    if (!treeRoot) return; // no SDD harness adopted: stay silent

    const unapproved = citedFeatures.filter((feature) => {
      const contractPath = contractFileFor(treeRoot, feature);
      if (!contractPath) return false; // sdd-specs already denies this case
      return !isApproved(contractPath);
    });

    if (unapproved.length === 0) return;

    deny(
      GATE_ID,
      `This implementation delegation cites feature(s) [${unapproved.join(', ')}] ` +
        'whose brief/contract has no recorded approval. Paste the FULL brief into the ' +
        'chat, get an explicit confirmation from the user (not a vague "dale"/"sigamos" ' +
        '— an actual sentence confirming they read it), then add this frontmatter to ' +
        'the top of the contract file before relaunching:\n' +
        '---\nstatus: approved\napproved_at: <ISO timestamp>\n' +
        'approval_quote: "<the user\'s own confirming words>"\n---',
    );
  },
);
