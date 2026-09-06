// The other half of the artifact standard: the generator emits the right shape, and this
// makes it STAY that way. It walks the real `.ai/` tree and fails on any artifact that
// drifted — a hand-edited file that lost its front matter, one dropped into the wrong
// directory, a check whose Evidence section was deleted, a recurrence entry the
// recurrence-lock gate would silently ignore.
//
// Deliberately reads the repo's own artifacts rather than fixtures: the standard is only
// worth anything if THIS project obeys it, and a fixture-only test would pass while the
// real tree rotted. cli/__tests__/artifacts.test.mjs covers the module's logic in
// isolation; this one covers the tree.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_KINDS,
  KINDS,
  artifactProblems,
  recurrenceRegistrySchema,
} from '../artifacts.mjs';
import { PROJECT_STATE_DIRECTORY, RECURRENCES_FILE } from '../constants.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_ROOT = join(REPO, PROJECT_STATE_DIRECTORY);
const MARKDOWN = '.md';

function artifactsOfKind(kind) {
  const directory = join(STATE_ROOT, KINDS[kind].directory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => extname(name).toLowerCase() === MARKDOWN)
    .map((name) => ({
      kind,
      slug: name.slice(0, -MARKDOWN.length),
      path: join(directory, name),
      relative: `${PROJECT_STATE_DIRECTORY}/${KINDS[kind].directory}/${name}`,
    }));
}

function allArtifacts() {
  return ARTIFACT_KINDS.flatMap(artifactsOfKind);
}

test('every generated artifact in .ai/ conforms to the standard', () => {
  const failures = [];
  for (const artifact of allArtifacts()) {
    const problems = artifactProblems(readFileSync(artifact.path, 'utf8'), {
      kind: artifact.kind,
      slug: artifact.slug,
    });
    if (problems.length > 0)
      failures.push(
        `${artifact.relative}:\n    - ${problems.join('\n    - ')}`,
      );
  }
  assert.deepEqual(
    failures,
    [],
    `Artifact(s) that drifted from the standard:\n  ${failures.join('\n  ')}`,
  );
});

test('a check never claims to have passed with its evidence left as the placeholder', () => {
  const unproven = [];
  for (const artifact of artifactsOfKind('check')) {
    const text = readFileSync(artifact.path, 'utf8');
    const passed = /^status:\s*passed\s*$/m.test(text);
    const placeholder = text.includes('Never fill this in before running it');
    if (passed && placeholder) unproven.push(artifact.relative);
  }
  assert.deepEqual(
    unproven,
    [],
    `Check(s) marked passed whose Evidence is still the generated placeholder — the whole ` +
      `point of a check is that the evidence is real:\n  ${unproven.join('\n  ')}`,
  );
});

test('the recurrence registry matches the shape recurrence-lock reads', () => {
  const path = join(STATE_ROOT, RECURRENCES_FILE);
  if (!existsSync(path)) return;
  const parsed = recurrenceRegistrySchema.safeParse(
    JSON.parse(readFileSync(path, 'utf8')),
  );
  const problems = parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
  assert.deepEqual(
    problems,
    [],
    `${PROJECT_STATE_DIRECTORY}/${RECURRENCES_FILE} is invalid:\n- ${problems.join('\n- ')}`,
  );
});

// The directory's own README documents the standard; it is the contract, not an artifact
// produced under it. Exempted by exact name so the exemption cannot widen into "any
// markdown someone drops at the top level".
const CONTRACT_DOCUMENT = 'README.md';

function looseMarkdownNames() {
  if (!existsSync(STATE_ROOT)) return [];
  return readdirSync(STATE_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && extname(entry.name).toLowerCase() === MARKDOWN,
    )
    .map((entry) => entry.name)
    .filter((name) => name !== CONTRACT_DOCUMENT);
}

test('no stray markdown sits loose in .ai/ instead of a kind directory', () => {
  const loose = looseMarkdownNames();
  assert.deepEqual(
    loose,
    [],
    `Markdown directly under ${PROJECT_STATE_DIRECTORY}/ has no declared kind. Move it into ` +
      `one of: ${ARTIFACT_KINDS.map((kind) => KINDS[kind].directory).join(', ')} ` +
      `(or generate it with \`claude-gates new <kind> <slug>\`): ${loose.join(', ')}`,
  );
});
