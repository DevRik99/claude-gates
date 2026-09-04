import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isDeny,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { skills = [] } = {}) {
  const project = makeProject({ prefix: 'dependency-skills-edge-' });
  for (const name of skills) {
    mkdirSync(join(project, '.claude', 'skills', name), { recursive: true });
  }
  return runGateProcess(GATE, payload, { project });
}

const STRIPE_ONLY = JSON.stringify({ dependencies: { stripe: '1.0.0' } });

// A skill dir must EQUAL the dependency or contain it as a whole `-` segment: "rip" does
// not satisfy "stripe".
test('an unrelated skill directory name that is a substring of the dependency does not satisfy the check', () => {
  assert.ok(
    isDeny(runGate(write('package.json', STRIPE_ONLY), { skills: ['rip'] })),
  );
});

test('a genuinely matching skill segment still exempts (stripe-payments covers stripe)', () => {
  assert.equal(
    runGate(write('package.json', STRIPE_ONLY), {
      skills: ['stripe-payments'],
    }),
    null,
  );
});

test('write_to_file with a different content field name is checked', () => {
  const result = runGate({
    tool_name: 'write_to_file',
    tool_input: { file_path: 'package.json', text: STRIPE_ONLY },
  });
  assert.ok(isDeny(result));
});
