// because the -c/-e patterns never see an interpreter fed from a heredoc
// (`python - <<'PY'`), a multi-line program that rewrote source files passed as an ordinary
// shell command through a whole session. These cover that hole and the two rules that close
// it: any inline script that writes files, and any inline script large enough to be a
// program rather than a command.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  decisionOf,
  makeProject,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const ENABLED = { gates: { blockTrivialInlineScripts: true } };

function run(command, config = ENABLED) {
  return runGateProcess(GATE, bash(command), {
    project: makeProject({ prefix: 'no-trivial-scripts-', config }),
  });
}

const WRITE_CALL = ['import io', "io.open('x.mjs', 'w').write('hi')"].join(
  '\n',
);
const READ_ONLY_BODY = ['import json', "print(json.load(open('a.json')))"].join(
  '\n',
);

function heredoc(body, interpreter = 'python -') {
  return `${interpreter} <<'PY'\n${body}\nPY`;
}

test('a heredoc script that writes files is denied', () => {
  const result = run(heredoc(WRITE_CALL));
  assert.equal(decisionOf(result), 'deny');
  assert.match(messageOf(result), /writes files/);
});

test('the denial names Write and Edit as the replacement', () => {
  assert.match(messageOf(run(heredoc(WRITE_CALL))), /Write|Edit/);
});

test('a heredoc script that only reads is allowed', () => {
  assert.equal(run(heredoc(READ_ONLY_BODY)), null);
});

test('the write rule catches node and ruby heredocs too, not just python', () => {
  const body = ["const fs = require('fs')", "fs.writeFileSync('x', 'y')"].join(
    '\n',
  );
  assert.equal(decisionOf(run(heredoc(body, 'node'))), 'deny');
});

test('a script over the line limit is denied even when it writes nothing', () => {
  const long = Array.from({ length: 120 }, (_, index) => `total += ${index}`);
  const result = run(
    heredoc(['total = 0', ...long, 'print(total)'].join('\n')),
  );
  assert.equal(decisionOf(result), 'deny');
  assert.match(messageOf(result), /line limit|-line inline script/);
});

test('the line limit is configurable, so a genuine one-off computation can pass', () => {
  const long = Array.from({ length: 120 }, (_, index) => `total += ${index}`);
  const command = heredoc(['total = 0', ...long, 'print(total)'].join('\n'));
  const raised = {
    gates: {
      blockTrivialInlineScripts: { enabled: true, maxInlineScriptLines: 500 },
    },
  };
  assert.equal(run(command, raised), null);
});

test('an ordinary command is untouched', () => {
  for (const command of ['npm test', 'git status', 'node --test'])
    assert.equal(run(command), null, `${command} must be allowed`);
});

test('a heredoc that is not an interpreter is not judged as a script', () => {
  assert.equal(run("cat <<'EOF'\njust some text\nEOF"), null);
});

test('dump-defaults exposes the line limit so it can be tuned', () => {
  const descriptor = runGateProcess(GATE, '', {
    environment: { CLAUDE_GATES_DUMP_DEFAULTS: '1' },
  });
  assert.equal(descriptor.configKey, 'blockTrivialInlineScripts');
  assert.equal(descriptor.defaultParams.maxInlineScriptLines, 100);
});
