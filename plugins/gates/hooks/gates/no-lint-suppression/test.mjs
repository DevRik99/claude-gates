import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  edit,
  isDeny,
  makeProject,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE, payload, options);
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
  assert.equal(runGate(write('/repo/a.ts', '// @ts-ignore'), { config }), null);
  assert.ok(
    isDeny(runGate(write('/repo/a.ts', 'foo(); // skip-check'), { config })),
  );
});

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('a zero that is not a lint rule is allowed in tsconfig and prettier config', () => {
  assert.equal(
    runGate(
      write(
        '/repo/tsconfig.json',
        '{ "compilerOptions": { "maxNodeModuleJsDepth": 0 } }',
      ),
    ),
    null,
  );
  assert.equal(
    runGate(write('/repo/.prettierrc', '{ "printWidth": 0 }')),
    null,
  );
});

test('every watched config variant is scanned', () => {
  const strictOff = '{ "compilerOptions": { "strict": false } }';
  assert.ok(isDeny(runGate(write('/repo/tsconfig.app.json', strictOff))));
  assert.ok(isDeny(runGate(write('/repo/tsconfig.base.json', strictOff))));
  assert.ok(isDeny(runGate(write('/repo/jsconfig.json', strictOff))));
  assert.ok(
    isDeny(
      runGate(
        write(
          '/repo/eslint.config.ts',
          'export default [{ rules: { "no-console": "off" } }];',
        ),
      ),
    ),
  );
  assert.ok(
    isDeny(
      runGate(
        write(
          '/repo/package.json',
          '{\n  "eslintConfig": {\n    "rules": {\n      "no-console": "off"\n    }\n  }\n}',
        ),
      ),
    ),
  );
  assert.ok(
    isDeny(
      runGate(
        write(
          '/repo/biome.json',
          '{\n  "linter": {\n    "enabled": false\n  }\n}',
        ),
      ),
    ),
  );
  assert.ok(
    isDeny(runGate(write('/repo/.eslintrc.yml', 'rules:\n  no-console: off'))),
  );
});

test('a rule set to ["off"] or downgraded to "warn" is a weakening', () => {
  assert.ok(
    isDeny(
      runGate(
        write('/repo/.eslintrc.json', '{ "rules": { "no-console": ["off"] } }'),
      ),
    ),
  );
  assert.ok(
    isDeny(
      runGate(
        write('/repo/.eslintrc.json', '{ "rules": { "no-console": "warn" } }'),
      ),
    ),
  );
  assert.ok(
    isDeny(
      runGate(
        write(
          '/repo/.eslintrc.json',
          '{\n  "rules": {\n    "eqeqeq": "off"\n  }\n}',
        ),
      ),
    ),
    'a plain key under a rules block is a rule',
  );
});

test('a package.json without eslintConfig is not a lint config', () => {
  assert.equal(
    runGate(write('/repo/package.json', '{ "name": "x", "private": false }')),
    null,
  );
});

test('.mdx is documentation, not source', () => {
  assert.equal(
    runGate(
      write('/repo/docs/guide.mdx', 'Use `// eslint-disable` sparingly.'),
    ),
    null,
  );
});

test('a suppression line already present in the file is not a new suppression', () => {
  const existing = '// @ts-ignore\nlegacy();\n';
  const project = makeProject({ files: { 'a.ts': existing } });
  assert.equal(
    runGate(write(join(project, 'a.ts'), `${existing}export const b = 2;\n`), {
      project,
    }),
    null,
    'a full-file rewrite keeping the old line passes',
  );
  assert.ok(
    isDeny(
      runGate(
        write(join(project, 'a.ts'), `${existing}// @ts-ignore\nmore();\n`),
        {
          project,
        },
      ),
    ),
    'a second, new suppression is denied',
  );
  assert.equal(
    runGate(
      edit(
        join(project, 'a.ts'),
        '// @ts-ignore\nlegacy(); // moved',
        existing,
      ),
      {
        project,
      },
    ),
    null,
    'an edit that keeps the existing directive passes',
  );
});

test('@ts-expect-error with a description is the recommended form and passes', () => {
  assert.equal(
    runGate(
      write(
        '/repo/a.ts',
        '// @ts-expect-error: the mock is intentionally partial\nfoo();',
      ),
    ),
    null,
  );
  assert.ok(
    isDeny(runGate(write('/repo/a.ts', '// @ts-expect-error\nfoo();'))),
  );
});

test('every added directive is caught', () => {
  for (const [file, line] of [
    ['a.js', '/* c8 ignore next */'],
    ['a.py', 'import os  # pylint: disable=unused-import'],
    ['a.py', 'x = y  # pyright: ignore'],
    ['a.go', 'func x() {} //nolint'],
    ['a.rs', '#[allow(dead_code)]'],
    ['a.cs', '#pragma warning disable CS0168'],
    ['A.java', '@SuppressWarnings("unchecked")'],
  ]) {
    assert.ok(
      isDeny(runGate(write(`/repo/${file}`, line))),
      `${line} must be denied`,
    );
  }
});
