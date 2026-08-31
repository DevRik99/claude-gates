import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'no-lint-suppression-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function write(filePath, content) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('DENIES an inline eslint-disable in a source file', () => {
  assert.ok(
    isDeny(
      runGate(
        write(
          '/repo/a.js',
          'const x = 1; // eslint-disable-next-line no-unused-vars',
        ),
      ),
    ),
  );
});

test('DENIES @ts-ignore / @ts-nocheck / # noqa', () => {
  assert.ok(isDeny(runGate(write('/repo/a.ts', '// @ts-ignore\nfoo();'))));
  assert.ok(isDeny(runGate(write('/repo/a.ts', '// @ts-nocheck'))));
  assert.ok(isDeny(runGate(write('/repo/a.py', 'import x  # noqa'))));
});

test('DENIES a config edit that turns a rule off', () => {
  assert.ok(
    isDeny(
      runGate(
        write(
          '/repo/eslint.config.mjs',
          'export default [{ rules: { "no-console": "off" } }];',
        ),
      ),
    ),
  );
});

test('DENIES disabling strict in tsconfig', () => {
  assert.ok(
    isDeny(
      runGate(
        write(
          '/repo/tsconfig.json',
          '{ "compilerOptions": { "strict": false } }',
        ),
      ),
    ),
  );
});

test('allows clean code with no suppression', () => {
  assert.equal(
    runGate(write('/repo/a.js', 'const x = 1;\nexport { x };')),
    null,
  );
});

test('allows a markdown file that merely documents a directive', () => {
  // Docs are not source: mentioning `// eslint-disable` in prose is not a suppression.
  assert.equal(
    runGate(
      write('/repo/README.md', 'Use `// eslint-disable-next-line` sparingly.'),
    ),
    null,
  );
});

test('escape hatch: lint-ok: on the same line allows a documented false positive', () => {
  assert.equal(
    runGate(
      write(
        '/repo/a.js',
        '// eslint-disable-next-line no-eval -- lint-ok: sandboxed by design\nrun(code);',
      ),
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(write('/repo/a.js', '// @ts-ignore'), {
      config: { gates: { blockLintSuppression: false } },
    }),
    null,
  );
});

test('project suppressionPatterns override replaces the built-in list', () => {
  const config = {
    gates: {
      blockLintSuppression: {
        enabled: true,
        suppressionPatterns: ['skip-check'],
      },
    },
  };
  // Built-in @ts-ignore is no longer in the list, so it passes.
  assert.equal(runGate(write('/repo/a.ts', '// @ts-ignore'), { config }), null);
  // The overridden pattern is enforced.
  assert.ok(
    isDeny(runGate(write('/repo/a.ts', 'foo(); // skip-check'), { config })),
  );
});
