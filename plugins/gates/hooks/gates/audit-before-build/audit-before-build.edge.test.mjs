import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  delegate,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLE = { config: { gates: { requireAuditBeforeBuilding: true } } };

// Known limitation: the audit evidence is a position-free phrase over the whole prompt, so
// audit language about something else still satisfies the check.
test('KNOWN LIMITATION: audit language elsewhere in the prompt, unrelated to the new tool, satisfies the check', () => {
  const prompt =
    'Context: earlier we confirmed no existing tool handles our deploy pipeline. ' +
    'Now, unrelated task: create a new script that scrapes user passwords from logs.';
  assert.equal(runGateProcess(GATE, delegate(prompt), ENABLE), null);
});

test('KNOWN LIMITATION: "justification:" in an unrelated docstring satisfies the check for any new tool file', () => {
  const content = [
    '// This module documents how other files use the phrase justification: <reason> in',
    '// their headers, as an example of our commenting convention.',
    'export function run() {}',
  ].join('\n');
  assert.equal(
    runGateProcess(GATE, write('scripts/new-thing.mjs', content), ENABLE),
    null,
  );
});

// The edit exemption is deliberate: a file already on disk is maintenance, not a build.
test('pre-creating an empty file at the target path makes the next write an edit (documented boundary)', () => {
  const project = makeProject({
    config: ENABLE.config,
    files: { 'scripts/sneaky.mjs': '' },
  });
  assert.equal(
    runGateProcess(
      GATE,
      write(join(project, 'scripts', 'sneaky.mjs'), 'export function run() {}'),
      { project },
    ),
    null,
  );
});
