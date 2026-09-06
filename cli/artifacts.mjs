// artifacts.mjs — the one definition of what a GENERATED artifact looks like and where it
// goes. Everything an agent produces that is not source code lands in one of a few shapes:
// a deterministic check it wrote so we can see whether something works, an audit result, a
// note explaining what it did, or an entry in the recurrence registry when it tripped on
// the same thing twice. Before this module each of those existed exactly once, in its own
// ad-hoc shape and its own ad-hoc place — GATES.md at the repo root, `.ai/tasks/
// .audit-reuse.md` hidden inside the task store, `impl.md` buried under a feature's task
// directory — so nothing could be found by convention and nothing could be checked.
//
// The module is deliberately shaped like registry.mjs, the pattern this repo already uses
// for "declare it once, validate it with zod": the KINDS table below is the contract, the
// generator renders from it, and the conformance test validates against it. A new required
// section is added in one place and both halves follow.
//
// Front matter is the machine-readable half and is identical across kinds, so a tool can
// answer "what is this file, who asked for it, is it still open" without parsing prose.
// The required SECTIONS are the human half, and they differ per kind because what makes a
// check trustworthy (a command, an expectation, the evidence it actually produced) is not
// what makes an audit trustworthy (what was searched, what exists, what was decided).

import { z } from 'zod';
import {
  ARTIFACT_DIRECTORIES,
  ARTIFACT_EXTENSION,
  PROJECT_STATE_DIRECTORY,
} from './constants.mjs';

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Statuses an artifact can carry. `open` is the only one a generator ever writes. */
export const ARTIFACT_STATUSES = ['open', 'passed', 'failed', 'closed'];

/**
 * The contract, per kind. `sections` are the level-2 headings the body must contain, in
 * any order; `summary` is what the kind is for, shown by `new --help` and in the docs.
 */
export const KINDS = Object.freeze({
  check: {
    directory: ARTIFACT_DIRECTORIES.check,
    summary:
      'A deterministic verification: the command to run, what it must print, and the ' +
      'evidence it actually printed. Written so a claim can be re-checked by anyone.',
    sections: ['Check', 'Expect', 'Evidence'],
  },
  audit: {
    directory: ARTIFACT_DIRECTORIES.audit,
    summary:
      'The result of looking before building: what was searched, what already exists, ' +
      'what is genuinely missing, and the decision that followed.',
    sections: ['Searched', 'Exists', 'Missing', 'Decision'],
  },
  note: {
    directory: ARTIFACT_DIRECTORIES.note,
    summary:
      'What was done and why, for work whose reasoning would otherwise live only in a ' +
      'chat log: the situation, what changed, and what it cost or left open.',
    sections: ['Context', 'Change', 'Outcome'],
  },
});

export const ARTIFACT_KINDS = Object.keys(KINDS);

export const frontMatterSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  slug: z.string().regex(SLUG_PATTERN, 'slug must be kebab-case'),
  title: z.string().min(1, 'title must not be empty'),
  created: z.string().regex(ISO_DATE_PATTERN, 'created must be YYYY-MM-DD'),
  status: z.enum(ARTIFACT_STATUSES),
  source: z.string().min(1, 'source must say what asked for this artifact'),
});

// The recurrence registry is not a document but a record, so it is a JSON schema rather
// than front matter. The shape is READ FROM the recurrence-lock gate, not invented here:
// the gate counts `classes[].occurrences[]` and reopens on anything whose `status` is not
// closed, so those three fields are what a generated entry must carry.
export const recurrenceSchema = z.object({
  class: z.string().min(1, 'class names the defect class, not one instance'),
  occurrences: z
    .array(z.object({ id: z.string().min(1), note: z.string().optional() }))
    .min(1),
  status: z.enum(['open', 'closed', 'cerrada']),
  block: z
    .string()
    .min(1, 'block names the deterministic guard that closes the class')
    .optional(),
});

export const recurrenceRegistrySchema = z.object({
  classes: z.array(recurrenceSchema),
});

/** Where an artifact of this kind and slug belongs, relative to the project root. */
export function artifactPathFor(kind, slug) {
  const definition = KINDS[kind];
  if (!definition) throw new Error(`unknown artifact kind: ${kind}`);
  if (!SLUG_PATTERN.test(slug))
    throw new Error(`slug must be kebab-case: ${slug}`);
  return [
    PROJECT_STATE_DIRECTORY,
    definition.directory,
    `${slug}${ARTIFACT_EXTENSION}`,
  ].join('/');
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────
// Line by line, no multi-line regex, so a long body can never backtrack — the same
// approach lib/capabilities.mjs uses on skill front matter.
function splitFrontMatter(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fields: null, body: text ?? '' };
  const fields = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') break;
    const separator = lines[index].indexOf(':');
    if (separator < 0) continue;
    const key = lines[index].slice(0, separator).trim();
    fields[key] = lines[index]
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return { fields, body: lines.slice(index + 1).join('\n') };
}

const SECTION_PREFIX = '## ';

function headingsIn(body) {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith(SECTION_PREFIX))
    .map((line) => line.slice(SECTION_PREFIX.length).trim());
}

/**
 * Every way an artifact file breaks the contract, as human-readable strings. Empty means
 * it conforms. Returning a list (never throwing) is what lets the conformance test report
 * every drifted file in one run instead of stopping at the first.
 */
export function artifactProblems(text, { kind, slug } = {}) {
  const { fields, body } = splitFrontMatter(text);
  if (fields === null)
    return ['missing front matter (the file must open with `---`)'];

  const parsed = frontMatterSchema.safeParse(fields);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) =>
          `front matter ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );

  if (kind && fields.kind !== kind)
    problems.push(
      `kind is "${fields.kind}" but the file sits in the ${kind} directory`,
    );
  if (slug && fields.slug !== slug)
    problems.push(`slug is "${fields.slug}" but the file is named "${slug}"`);

  const definition = KINDS[fields.kind];
  if (definition) {
    const present = new Set(headingsIn(body));
    const missing = definition.sections.filter(
      (section) => !present.has(section),
    );
    if (missing.length > 0)
      problems.push(`missing required section(s): ${missing.join(', ')}`);
  }
  return problems;
}

// ── Generation ──────────────────────────────────────────────────────────────────────
const PLACEHOLDERS = {
  Check: 'The exact command, copy-pasteable, that decides this.',
  Expect:
    'What that command must print or exit with for this to count as passing.',
  Evidence:
    'What it ACTUALLY printed when run. Never fill this in before running it.',
  Searched:
    'Where you looked: this repo, installed deps, the registry, the web.',
  Exists: 'What you found that already covers part of this.',
  Missing:
    'What genuinely does not exist yet, and is therefore worth building.',
  Decision: 'What was decided and why, in one or two sentences.',
  Context: 'The situation this work started from.',
  Change: 'What actually changed, concretely.',
  Outcome: 'The result, including what it cost or left open.',
};

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 'YYYY-MM-DD'.length);
}

/** The skeleton for a new artifact: valid front matter plus every required section. */
export function renderArtifact({ kind, slug, title, source, now }) {
  const definition = KINDS[kind];
  if (!definition) throw new Error(`unknown artifact kind: ${kind}`);
  const frontMatter = [
    '---',
    `kind: ${kind}`,
    `slug: ${slug}`,
    `title: ${title}`,
    `created: ${todayIso(now)}`,
    'status: open',
    `source: ${source}`,
    '---',
  ];
  const sections = definition.sections.map(
    (section) => `## ${section}\n\n${PLACEHOLDERS[section] ?? 'TODO'}\n`,
  );
  return `${frontMatter.join('\n')}\n\n# ${title}\n\n${sections.join('\n')}`;
}
