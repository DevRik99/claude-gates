import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { delegate, isDeny, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config, files, cwd } = {}) {
  return runGateProcess(GATE, payload, { config, files, cwd });
}

const ENABLE = { config: { gates: { requireAuditBeforeBuilding: true } } };

test('denies delegation to create a new tool without audit evidence', () => {
  assert.ok(
    isDeny(runGate(delegate('create a new script that checks X'), ENABLE)),
  );
});

test('allows delegation with audit evidence stated', () => {
  assert.equal(
    runGate(
      delegate(
        'create a new script that checks X. audited and no existing tool covers this.',
      ),
      ENABLE,
    ),
    null,
  );
});

test('denies writing a new executable tool file without a justification comment', () => {
  assert.ok(
    isDeny(
      runGate(
        write('scripts/check-thing.mjs', 'export function run() {}'),
        ENABLE,
      ),
    ),
  );
});

test('allows writing a tool file with a justification comment', () => {
  assert.equal(
    runGate(
      write(
        'scripts/check-thing.mjs',
        '// justification: no existing tool does this\nexport function run() {}',
      ),
      ENABLE,
    ),
    null,
  );
});

test('allows a write outside tool folders or non-executable extension', () => {
  assert.equal(runGate(write('docs/notes.md', 'plain notes'), ENABLE), null);
  assert.equal(runGate(write('scripts/data.json', '{}'), ENABLE), null);
});

test('denies delegation to create a new tool without audit evidence, in Spanish', () => {
  assert.ok(
    isDeny(runGate(delegate('crea un nuevo script que verifique X'), ENABLE)),
  );
});

test('bilingual control: ES and EN equivalent new-tool delegations both deny without audit evidence', () => {
  assert.ok(
    isDeny(runGate(delegate('crea un nuevo script que verifique X'), ENABLE)),
  );
  assert.ok(
    isDeny(runGate(delegate('create a new script that checks X'), ENABLE)),
  );
});

test('allows a Spanish delegation with audit evidence stated', () => {
  assert.equal(
    runGate(
      delegate(
        'crea un nuevo script que verifique X. audite y no existe una herramienta que cubra esto.',
      ),
      ENABLE,
    ),
    null,
  );
});

test('disabled by default (registry default is false)', () => {
  assert.equal(runGate(delegate('create a new script that checks X')), null);
});

// ── Tool coverage: MCP delegation and every payload field shape ─────────────────────
test('an MCP delegation tool (mcp__x__spawn_agent) is checked like a native Agent', () => {
  const payload = {
    tool_name: 'mcp__orchestrator__spawn_agent',
    tool_input: { prompt: 'create a new script that checks X' },
  };
  assert.ok(isDeny(runGate(payload, ENABLE)));
});

test('a delegation prompt carried in task/description is read', () => {
  assert.ok(
    isDeny(
      runGate(
        {
          tool_name: 'Agent',
          tool_input: { task: 'create a new script that checks X' },
        },
        ENABLE,
      ),
    ),
  );
});

test('a write path carried in `path` and content in edits[] are read', () => {
  assert.ok(
    isDeny(
      runGate(
        {
          tool_name: 'mcp__fs__write_file',
          tool_input: { path: 'scripts/new.mjs', content: 'export {}' },
        },
        ENABLE,
      ),
    ),
  );
  assert.equal(
    runGate(
      {
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: 'scripts/new.mjs',
          edits: [{ old_string: '', new_string: '// justification: x' }],
        },
      },
      ENABLE,
    ),
    null,
  );
});

test('a non-string file_path never crashes into a deny', () => {
  assert.equal(
    runGate(
      { tool_name: 'Write', tool_input: { file_path: 42, content: 'x' } },
      ENABLE,
    ),
    null,
  );
});

// ── False positives from the audit ──────────────────────────────────────────────────
test('"run the build script and report failures" is not a build intent', () => {
  assert.equal(
    runGate(delegate('run the build script and report failures'), ENABLE),
    null,
  );
});

test('"add tests for the gate module" is not a build intent', () => {
  assert.equal(
    runGate(delegate('add tests for the gate module'), ENABLE),
    null,
  );
});

test('an accented Spanish creation verb is still detected', () => {
  assert.ok(isDeny(runGate(delegate('creá un script que valide X'), ENABLE)));
  assert.ok(isDeny(runGate(delegate('agregá un hook de commit'), ENABLE)));
});

test('tool folders match by path segment, not substring', () => {
  assert.equal(
    runGate(write('.git/hooks/pre-commit.sh', '#!/bin/sh'), ENABLE),
    null,
  );
  assert.equal(
    runGate(write('node_modules/x/scripts/build.js', 'x'), ENABLE),
    null,
  );
  assert.equal(runGate(write('src/mytools/thing.mjs', 'x'), ENABLE), null);
  assert.ok(isDeny(runGate(write('src/tools/thing.mjs', 'x'), ENABLE)));
});

test('a test file under a tool folder is not a new tool', () => {
  assert.equal(runGate(write('scripts/check.test.mjs', 'x'), ENABLE), null);
  assert.equal(runGate(write('hooks/gates/foo/test.mjs', 'x'), ENABLE), null);
});

test('a configured toolFolders entry with a trailing slash still works', () => {
  const config = {
    gates: {
      requireAuditBeforeBuilding: { enabled: true, toolFolders: ['bin/'] },
    },
  };
  assert.ok(isDeny(runGate(write('bin/run.mjs', 'x'), { config })));
  assert.equal(runGate(write('scripts/run.mjs', 'x'), { config }), null);
});

test('a relative path to an existing file is resolved against the project root (an edit, not a build)', () => {
  assert.equal(
    runGate(write('scripts/existing.mjs', 'export {}'), {
      ...ENABLE,
      files: { 'scripts/existing.mjs': '// already here' },
    }),
    null,
  );
});
