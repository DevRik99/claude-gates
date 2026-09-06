// Unit coverage for the artifact standard itself: the paths it computes, the skeleton it
// renders, and every way it must recognize a broken artifact. The companion
// artifact-conformance.test.mjs applies the same module to the repo's real `.ai/` tree.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIFACT_KINDS,
  KINDS,
  artifactPathFor,
  artifactProblems,
  recurrenceRegistrySchema,
  renderArtifact,
} from '../artifacts.mjs';

const VALID = {
  kind: 'check',
  slug: 'lint-clean',
  title: 'npm run lint exits 0',
  source: 'a test',
};

function generated(overrides = {}) {
  return renderArtifact({ ...VALID, ...overrides });
}

test('each kind lands in its own directory under .ai/', () => {
  assert.equal(artifactPathFor('check', 'x'), '.ai/checks/x.md');
  assert.equal(artifactPathFor('audit', 'x'), '.ai/audits/x.md');
  assert.equal(artifactPathFor('note', 'x'), '.ai/notes/x.md');
});

test('an unknown kind or a non-kebab slug is refused, not guessed at', () => {
  assert.throws(
    () => artifactPathFor('nonsense', 'x'),
    /unknown artifact kind/,
  );
  assert.throws(() => artifactPathFor('check', 'Not Kebab'), /kebab-case/);
  assert.throws(() => renderArtifact({ ...VALID, kind: 'nope' }), /unknown/);
});

test('what the generator emits conforms to the standard, for every kind', () => {
  for (const kind of ARTIFACT_KINDS) {
    const text = renderArtifact({ ...VALID, kind, slug: 'some-slug' });
    assert.deepEqual(
      artifactProblems(text, { kind, slug: 'some-slug' }),
      [],
      `generated ${kind} should conform`,
    );
    for (const section of KINDS[kind].sections)
      assert.match(text, new RegExp(`^## ${section}$`, 'm'));
  }
});

test('a generated artifact always starts open, never pre-claiming a result', () => {
  assert.match(generated(), /^status: open$/m);
});

test('the created date is a plain ISO day', () => {
  assert.match(
    renderArtifact({ ...VALID, now: new Date('2026-09-06T13:45:00Z') }),
    /^created: 2026-09-06$/m,
  );
});

// ── What the validator must catch ───────────────────────────────────────────────────
test('a file with no front matter is reported, not silently accepted', () => {
  assert.deepEqual(artifactProblems('# just a heading\n'), [
    'missing front matter (the file must open with `---`)',
  ]);
});

test('a missing required section is named explicitly', () => {
  const withoutEvidence = generated().replace(/## Evidence[\S\s]*$/, '');
  const problems = artifactProblems(withoutEvidence, VALID);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing required section\(s\): Evidence/);
});

test('a kind or slug that disagrees with the file location is reported', () => {
  const text = generated();
  assert.match(
    artifactProblems(text, { kind: 'note', slug: 'lint-clean' }).join(' '),
    /sits in the note directory/,
  );
  assert.match(
    artifactProblems(text, { kind: 'check', slug: 'other' }).join(' '),
    /the file is named "other"/,
  );
});

test('a malformed front matter field is reported per field', () => {
  const problems = artifactProblems(
    generated()
      .replace('created: ', 'created: not-a-date ')
      .replace('status: open', 'status: maybe'),
    VALID,
  );
  assert.match(problems.join(' '), /created must be YYYY-MM-DD/);
  assert.match(problems.join(' '), /status/);
});

test('an empty source is refused: an artifact must say what asked for it', () => {
  const problems = artifactProblems(
    generated().replace('source: a test', 'source:'),
    VALID,
  );
  assert.match(problems.join(' '), /source/);
});

// ── The recurrence registry ─────────────────────────────────────────────────────────
test('a well-formed recurrence registry validates', () => {
  const result = recurrenceRegistrySchema.safeParse({
    classes: [
      {
        class: 'gate written without its smoke fixture',
        occurrences: [
          { id: 'skill-first' },
          { id: 'tool-map', note: 'same miss' },
        ],
        status: 'open',
        block: 'cli/__tests__/smoke-coverage.test.mjs',
      },
    ],
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test('a recurrence with no occurrences is refused: a class needs instances', () => {
  const result = recurrenceRegistrySchema.safeParse({
    classes: [{ class: 'x', occurrences: [], status: 'open' }],
  });
  assert.equal(result.success, false);
});

test("recurrence-lock's Spanish closed status stays valid", () => {
  const result = recurrenceRegistrySchema.safeParse({
    classes: [{ class: 'x', occurrences: [{ id: 'a' }], status: 'cerrada' }],
  });
  assert.ok(result.success);
});
