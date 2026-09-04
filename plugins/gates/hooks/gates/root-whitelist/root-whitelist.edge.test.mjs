// Edge cases for root-whitelist: bypasses and false positives.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  isDeny,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function project({ config } = {}) {
  const root = makeProject({ prefix: 'root-whitelist-edge-', config });
  return {
    root,
    run(payload) {
      return runGateProcess(GATE, payload, { project: root });
    },
  };
}

function mcpTool(name, input) {
  return { tool_name: name, tool_input: input };
}

test('FIXED: mcp filesystem write_file creating an orphan root file is now recognized', () => {
  const { root, run } = project();
  const result = run(
    mcpTool('mcp__filesystem__write_file', {
      path: join(root, 'orphan-mcp.txt'),
      content: 'x',
    }),
  );
  assert.ok(isDeny(result));
});

test('FIXED: a relative file_path targeting the root is now caught by resolving it against cwd', () => {
  const { run } = project();
  assert.ok(isDeny(run(write('orphan-relative.txt'))));
});

test('OK: a traversal path that normalizes back to the root is still caught', () => {
  const { root, run } = project();
  const result = run(write(join(root, 'src', '..', 'orphan-traversal.txt')));
  assert.ok(isDeny(result));
});

test('OK: a root-level file named identically to a whitelisted folder is still denied under the file whitelist', () => {
  const { root, run } = project();
  assert.ok(isDeny(run(write(join(root, 'src')))));
});

test('FIXED: a root file matching the whitelist except for letter case is now allowed', () => {
  const { root, run } = project();
  assert.equal(run(write(join(root, 'Package.json'))), null);
});

test('FIXED: a shell redirection creating an orphan root file is now denied', () => {
  const { run } = project();
  assert.ok(
    isDeny(run(bash('printf "x" > basura.txt'))),
    'printf > basura.txt must be denied',
  );
});

test('FIXED: touch of an orphan root file via Bash is now denied', () => {
  const { run } = project();
  assert.ok(
    isDeny(run(bash('touch orphan.js'))),
    'touch orphan.js must be denied',
  );
});

test('OK: a shell redirection into a whitelisted folder is allowed', () => {
  const { run } = project();
  assert.equal(run(bash('echo x > src/ok.js')), null, 'src/ is whitelisted');
});

test('OK: a shell command that creates nothing (git status) is allowed', () => {
  const { run } = project();
  assert.equal(run(bash('git status')), null);
});

test('a variable-built target is not resolved and passes', () => {
  const { run } = project();
  assert.equal(run(bash('echo x > "$OUT"')), null);
});
