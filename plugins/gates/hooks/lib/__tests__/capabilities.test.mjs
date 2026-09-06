import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  distinctiveTokens,
  entriesForKind,
  firstClause,
  hasSkillAuditEvidence,
  parseFrontMatter,
  relevantCapabilities,
  truncateAtWordBoundary,
} from '../capabilities.mjs';

const DATAVIZ = {
  name: 'dataviz',
  description:
    'Use this skill whenever you are about to create any chart, graph, plot, dashboard ' +
    'or data visualization, including legend, axis and tooltip decisions.',
};
const A11Y = {
  name: 'a11y-doctrine',
  description:
    'Referencia normativa de accesibilidad web: contraste, teclado, lectores de pantalla.',
};

// ── Front matter ────────────────────────────────────────────────────────────────────
test('parses name and description out of front matter', () => {
  const parsed = parseFrontMatter(
    '---\nname: x\ndescription: Does a thing.\n---\nbody',
  );
  assert.deepEqual(parsed, { name: 'x', description: 'Does a thing.' });
});

test('a block scalar description is read from the indented lines that follow', () => {
  const parsed = parseFrontMatter(
    '---\nname: x\ndescription: >-\n  first line\n  second line\n---\n',
  );
  assert.equal(parsed.description, 'first line second line');
});

test('a file with no front matter yields empty fields instead of throwing', () => {
  assert.deepEqual(parseFrontMatter('# just a heading\n'), {
    name: '',
    description: '',
  });
});

// ── Blurbs ──────────────────────────────────────────────────────────────────────────
test('firstClause keeps only the first sentence, capped at the budget', () => {
  assert.equal(firstClause('One. Two. Three.', 120), 'One');
  assert.equal(truncateAtWordBoundary('one two three', 8), 'one…');
});

// ── Discovery ───────────────────────────────────────────────────────────────────────
test('a project skill shadows a home skill of the same name', () => {
  const home = mkdtempSync(join(tmpdir(), 'caps-home-'));
  const project = mkdtempSync(join(tmpdir(), 'caps-project-'));
  for (const [root, flavor] of [
    [home, 'Global flavor.'],
    [project, 'Project flavor.'],
  ]) {
    const directory = join(root, '.claude', 'skills', 'deploy');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: deploy\ndescription: ${flavor}\n---\n`,
    );
  }
  const previous = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const entries = entriesForKind('skills', project, {});
    assert.equal(entries.filter((entry) => entry.name === 'deploy').length, 1);
  } finally {
    process.env.USERPROFILE = previous;
  }
});

test('an unknown kind yields no entries instead of throwing', () => {
  assert.deepEqual(entriesForKind('nonsense', tmpdir(), {}), []);
});

// ── Tokens ──────────────────────────────────────────────────────────────────────────
test('stopwords and short words never become distinctive tokens', () => {
  const tokens = distinctiveTokens('the user should use this file for a chart');
  assert.ok(tokens.has('chart'));
  for (const noise of ['user', 'file', 'this', 'the', 'for', 'use'])
    assert.ok(!tokens.has(noise), `"${noise}" should not be distinctive`);
});

// ── Relevance ───────────────────────────────────────────────────────────────────────
test('an action naming the skill outranks one that merely overlaps', () => {
  const named = relevantCapabilities('run the dataviz check on this', [
    DATAVIZ,
  ]);
  assert.equal(named[0].name, 'dataviz');
  assert.ok(named[0].named);
  const overlapped = relevantCapabilities(
    'draw a chart with a legend, an axis and a tooltip',
    [DATAVIZ],
  );
  assert.equal(overlapped[0].named, false);
  assert.ok(named[0].score > overlapped[0].score);
});

test('a hyphenated name is recognized when written as separate words', () => {
  const matches = relevantCapabilities('follow the a11y doctrine here', [A11Y]);
  assert.equal(matches[0]?.name, 'a11y-doctrine');
});

test('Spanish prose matches a Spanish description', () => {
  const matches = relevantCapabilities(
    'revisar el contraste, el teclado y los lectores de pantalla',
    [A11Y, DATAVIZ],
  );
  assert.equal(matches[0]?.name, 'a11y-doctrine');
});

test('an unrelated action matches nothing', () => {
  assert.deepEqual(
    relevantCapabilities('rename a variable in the parser helper', [
      DATAVIZ,
      A11Y,
    ]),
    [],
  );
});

test('empty or whitespace text matches nothing', () => {
  assert.deepEqual(relevantCapabilities('', [DATAVIZ]), []);
  assert.deepEqual(relevantCapabilities('   ', [DATAVIZ]), []);
  assert.deepEqual(relevantCapabilities('anything', null), []);
});

test('minTokenOverlap raises the bar and maxMatches caps the list', () => {
  const text =
    'chart legend axis tooltip dashboard visualization contraste teclado';
  assert.equal(
    relevantCapabilities(text, [DATAVIZ, A11Y], { minTokenOverlap: 99 }).length,
    0,
  );
  assert.equal(
    relevantCapabilities(text, [DATAVIZ, A11Y], { maxMatches: 1 }).length,
    1,
  );
});

test('an entry with no name is skipped rather than crashing the match', () => {
  assert.deepEqual(
    relevantCapabilities('chart legend axis tooltip', [{ description: 'x' }]),
    [],
  );
});

// ── The audit statement ─────────────────────────────────────────────────────────────
test('the audit statement is recognized in both languages and several shapes', () => {
  for (const text of [
    '// no skill covers this',
    'using the dataviz skill',
    'using skill: dataviz',
    'skill: dataviz',
    'sin skill aplicable',
    'ninguna skill cubre esto',
    'usando la skill de dataviz',
    'skill-checked',
  ])
    assert.ok(hasSkillAuditEvidence(text), `should clear: ${text}`);
});

test('ordinary prose is not mistaken for an audit statement', () => {
  for (const text of [
    'export function render() { return plot(data); }',
    'this repo has tests for skills',
    '',
  ])
    assert.ok(!hasSkillAuditEvidence(text), `should not clear: ${text}`);
});
