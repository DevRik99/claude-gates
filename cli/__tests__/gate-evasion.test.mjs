// because neutral-spanish caught `tenés` but not `tenes`, the question is how many other
// gates match only the spelling they were written against. This takes each gate's OWN known
// violation (the smoke fixture that proves it reacts) and rewrites it the way a person
// actually types — no accents, extra spaces — then asserts the gate still fires.
//
// Only meaning-preserving mutations are applied. Uppercasing a shell command is not an
// evasion because `GIT RESET` does not run, so it is used on prose and file content only;
// a battery that flagged unrunnable commands would report holes nobody can fall through.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const GATES_DIR = join(REPO, 'plugins', 'gates', 'hooks', 'gates');
const GATE_RUN_TIMEOUT_MS = 10000;

const FIXTURES = JSON.parse(
  readFileSync(join(HERE, '..', 'smoke-fixtures.json'), 'utf8'),
).fixtures;

function scratchProject(configKey) {
  const project = mkdtempSync(join(tmpdir(), 'gate-evasion-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ gates: { [configKey]: { enabled: true } } }),
  );
  return project;
}

function deniesOrWarns(id, payload, project) {
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [join(GATES_DIR, id, 'index.mjs')],
      {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: project,
        env: {
          ...process.env,
          HOME: project,
          USERPROFILE: project,
          CLAUDE_GATES_LOG: '0',
        },
        timeout: GATE_RUN_TIMEOUT_MS,
      },
    );
  } catch {
    return false;
  }
  const trimmed = stdout.trim();
  if (!trimmed) return false;
  try {
    const output = JSON.parse(trimmed).hookSpecificOutput ?? {};
    return (
      output.permissionDecision === 'deny' ||
      typeof output.additionalContext === 'string'
    );
  } catch {
    return false;
  }
}

const TEXT_FIELDS = [
  'command',
  'content',
  'prompt',
  'new_string',
  'description',
];

function mutatePayload(payload, mutate) {
  const input = { ...payload.tool_input };
  let touched = false;
  for (const field of TEXT_FIELDS) {
    if (typeof input[field] !== 'string') continue;
    const next = mutate(input[field]);
    if (next !== input[field]) touched = true;
    input[field] = next;
  }
  return touched ? { ...payload, tool_input: input } : null;
}

const stripAccents = (text) =>
  text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
const widenSpaces = (text) => text.replace(/ /g, '  ');

const MUTATIONS = [
  ['written without accents', stripAccents],
  ['written with doubled spaces', widenSpaces],
];

const reactingFixtures = FIXTURES.filter(
  (fixture) =>
    !fixture.needsState && fixture.type !== 'none' && fixture.payload,
);

for (const [label, mutate] of MUTATIONS) {
  test(`every gate still reacts to its own violation ${label}`, () => {
    const holes = [];
    for (const fixture of reactingFixtures) {
      const project = scratchProject(fixture.configKey);
      if (!deniesOrWarns(fixture.id, fixture.payload, project)) continue;

      const mutated = mutatePayload(fixture.payload, mutate);
      if (!mutated) continue;
      if (!deniesOrWarns(fixture.id, mutated, project))
        holes.push(`${fixture.id} stopped reacting when ${label}`);
    }
    assert.deepEqual(
      holes,
      [],
      `A gate that matches only the exact spelling it was written against is evaded by ` +
        `ordinary typing:\n  ${holes.join('\n  ')}`,
    );
  });
}
