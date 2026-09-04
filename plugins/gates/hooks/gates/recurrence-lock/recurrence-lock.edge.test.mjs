import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  isDeny,
  makeProject,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function projectWith(classes) {
  return makeProject({
    prefix: 'recurrence-lock-edge-',
    files: { '.ai/reincidencias.json': JSON.stringify({ classes }) },
  });
}

const mutate = () => bash('npm run build');

test('mcp__ide__executeCode is covered because it is in the execution group', () => {
  const project = projectWith([
    { class: 'x', occurrences: [1, 2], status: 'open' },
  ]);
  assert.ok(
    isDeny(
      runGateProcess(
        GATE,
        { tool_name: 'mcp__ide__executeCode', tool_input: {} },
        { project },
      ),
    ),
  );
});

test('a status of "Closed " (capitalized, trailing space) is trimmed and recognized as closed', () => {
  const project = projectWith([
    { class: 'x', occurrences: [1, 2], status: 'Closed ' },
  ]);
  assert.equal(runGateProcess(GATE, mutate(), { project }), null);
});

test('a genuine typo status like "closd" is NOT recognized as closed (no typo-tolerance)', () => {
  const project = projectWith([
    { class: 'x', occurrences: [1, 2], status: 'closd' },
  ]);
  assert.ok(isDeny(runGateProcess(GATE, mutate(), { project })));
});

test('duplicate identical entries in occurrences[] are deduplicated before counting', () => {
  const project = projectWith([
    { class: 'dup', occurrences: [1, 1], status: 'open' },
  ]);
  assert.equal(runGateProcess(GATE, mutate(), { project }), null);
});

test('distinct occurrence entries (identified by id) still count toward the threshold', () => {
  const project = projectWith([
    {
      class: 'distinct',
      occurrences: [{ id: 'a' }, { id: 'b' }],
      status: 'open',
    },
  ]);
  assert.ok(isDeny(runGateProcess(GATE, mutate(), { project })));
});
