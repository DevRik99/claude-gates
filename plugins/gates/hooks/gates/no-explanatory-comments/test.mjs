import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  edit,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function writeIn(project, relative, content) {
  return runGateProcess(GATE, write(join(project, relative), content), {
    project,
  });
}

test('denies a new comment that narrates what the code does', () => {
  const project = makeProject();
  const result = writeIn(
    project,
    'src/a.mjs',
    '// reads the config file and returns it\nexport function read() {}\n',
  );
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /reads the config file/);
});

test('allows a comment that records a decision (because / porque / instead of)', () => {
  const project = makeProject();
  assert.equal(
    writeIn(
      project,
      'src/a.mjs',
      '// cached because the file is read on every hook call\nexport const x = 1;\n',
    ),
    null,
  );
  assert.equal(
    writeIn(
      project,
      'src/b.mjs',
      '// se lee una sola vez porque cada hook es un proceso nuevo\nexport const x = 1;\n',
    ),
    null,
  );
  assert.equal(
    writeIn(
      project,
      'src/c.mjs',
      '/* a plain loop instead of a regex: the linter flags it as super-linear */\nexport const x = 1;\n',
    ),
    null,
  );
});

test('allows tool directives, licenses, TODO/FIXME with reason, JSDoc types and URLs', () => {
  const project = makeProject();
  const content = [
    '#!/usr/bin/env node',
    '// eslint-disable-next-line no-console',
    '/** @type {import("x").Y} */',
    '// TODO: drop when node 22 is the floor',
    '// https://example.com/spec',
    'export const x = 1;',
  ].join('\n');
  assert.equal(writeIn(project, 'src/a.mjs', content), null);
});

test('the escape hatch marker allows a documented exception', () => {
  const project = makeProject();
  assert.equal(
    writeIn(
      project,
      'src/a.mjs',
      '// comment-ok: reviewer asked for this walkthrough\n// reads the file then parses it\nexport const x = 1;\n',
    ),
    null,
  );
});

test('only NEW comments count: a comment already on disk is not judged again', () => {
  const project = makeProject({
    files: { 'src/a.mjs': '// reads the config file\nexport const x = 1;\n' },
  });
  assert.equal(
    writeIn(
      project,
      'src/a.mjs',
      '// reads the config file\nexport const x = 1;\nexport const y = 2;\n',
    ),
    null,
  );
  const result = writeIn(
    project,
    'src/a.mjs',
    '// reads the config file\n// then returns the parsed value\nexport const x = 1;\n',
  );
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /returns the parsed value/);
});

test('an Edit is judged on new_string minus old_string', () => {
  const project = makeProject();
  const kept = runGateProcess(
    GATE,
    edit(
      join(project, 'src', 'a.mjs'),
      '// loops over items\nfor (const a of b) {}',
      '// loops over items\nfor (const a of c) {}',
    ),
    { project },
  );
  assert.equal(kept, null);
  const added = runGateProcess(
    GATE,
    edit(
      join(project, 'src', 'a.mjs'),
      '// increments the counter\ncount += 1;',
      'count += 1;',
    ),
    { project },
  );
  assert.ok(isDeny(added));
});

test('a block comment is judged as one unit: a decision anywhere in it allows it', () => {
  const project = makeProject();
  const content =
    '/**\n * Parses the input.\n * Kept synchronous because hooks must answer before the tool runs.\n */\nexport function parse() {}\n';
  assert.equal(writeIn(project, 'src/a.ts', content), null);
});

test('python and shell hash comments are judged; strings with # are not', () => {
  const project = makeProject();
  assert.ok(
    isDeny(writeIn(project, 'app.py', '# opens the socket\nsock = open()\n')),
  );
  assert.equal(writeIn(project, 'app.py', 'x = "#not a comment"\n'), null);
  assert.equal(
    writeIn(
      project,
      'run.sh',
      '#!/bin/sh\n# because set -e would abort the cleanup trap\nset +e\n',
    ),
    null,
  );
});

test('non-code files are never judged', () => {
  const project = makeProject();
  assert.equal(
    writeIn(project, 'README.md', '<!-- explains everything -->\n'),
    null,
  );
  assert.equal(writeIn(project, 'data.json', '{"a": 1}\n'), null);
});

test('disabled by config', () => {
  const project = makeProject({
    config: { gates: { blockExplanatoryComments: false } },
  });
  assert.equal(
    writeIn(project, 'src/a.mjs', '// reads the config file\n'),
    null,
  );
});
