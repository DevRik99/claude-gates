import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  edit,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config, skills = [], files, cwd } = {}) {
  const project = makeProject({ prefix: 'dependency-skills-', config, files });
  for (const name of skills) {
    mkdirSync(join(project, '.claude', 'skills', name), { recursive: true });
  }
  return runGateProcess(GATE, payload, { project, cwd });
}

function writePackageJson(content) {
  return write('package.json', content);
}

const STRIPE_ONLY = JSON.stringify({ dependencies: { stripe: '1.0.0' } });

test('denies when a new dependency has no matching skill', () => {
  assert.ok(isDeny(runGate(writePackageJson(STRIPE_ONLY))));
});

test('allows when the dependency has a matching skill directory', () => {
  assert.equal(
    runGate(writePackageJson(STRIPE_ONLY), { skills: ['stripe'] }),
    null,
  );
});

test('allows an exempt dependency without its own API', () => {
  const package_ = JSON.stringify({
    dependencies: { clsx: '1.0.0', '@types/node': '1.0.0' },
  });
  assert.equal(runGate(writePackageJson(package_)), null);
});

test('allows a non-package.json write and unparseable content', () => {
  assert.equal(runGate(write('src/index.js', 'x')), null);
  assert.equal(
    runGate(writePackageJson('{ "dependencies": { incomplete')),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(writePackageJson(STRIPE_ONLY), {
      config: { gates: { requireSkillForNewDependency: false } },
    }),
    null,
  );
});

test('project projectSkillsDir override is honored', () => {
  const project = makeProject({
    prefix: 'dependency-skills-',
    config: {
      gates: {
        requireSkillForNewDependency: {
          enabled: true,
          projectSkillsDir: 'custom-skills',
        },
      },
    },
  });
  mkdirSync(join(project, 'custom-skills', 'stripe'), { recursive: true });
  assert.equal(
    runGateProcess(GATE, writePackageJson(STRIPE_ONLY), { project }),
    null,
  );
});

// ── Only NEW dependencies are judged ────────────────────────────────────────────────
test('a full package.json rewrite that keeps an existing unskilled dependency is allowed', () => {
  const files = { 'package.json': STRIPE_ONLY };
  assert.equal(runGate(writePackageJson(STRIPE_ONLY), { files }), null);
});

test('a version bump of an existing dependency is allowed', () => {
  const files = { 'package.json': STRIPE_ONLY };
  const bumped = JSON.stringify({ dependencies: { stripe: '2.0.0' } });
  assert.equal(runGate(writePackageJson(bumped), { files }), null);
});

test('a rewrite that adds one new dependency names only the new one', () => {
  const files = { 'package.json': STRIPE_ONLY };
  const added = JSON.stringify({
    dependencies: { stripe: '1.0.0', axios: '1.0.0' },
  });
  const result = runGate(writePackageJson(added), { files });
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /axios/);
  assert.doesNotMatch(messageOf(result), /stripe/);
});

test('an Edit fragment is applied to the package.json on disk, so a new dependency is caught', () => {
  const files = {
    'package.json': '{\n  "dependencies": {\n    "clsx": "1.0.0"\n  }\n}\n',
  };
  const payload = edit(
    'package.json',
    '"clsx": "1.0.0",\n    "stripe": "1.0.0"',
    '"clsx": "1.0.0"',
  );
  assert.ok(isDeny(runGate(payload, { files })));
});

test('an Edit that only bumps a version is allowed', () => {
  const files = {
    'package.json': '{ "dependencies": { "stripe": "1.0.0" } }',
  };
  assert.equal(
    runGate(edit('package.json', '"stripe": "2.0.0"', '"stripe": "1.0.0"'), {
      files,
    }),
    null,
  );
});

// ── Shell installs ──────────────────────────────────────────────────────────────────
test('npm install <pkg> is judged like a package.json write', () => {
  assert.ok(isDeny(runGate(bash('npm install stripe'))));
  assert.equal(
    runGate(bash('npm install stripe'), { skills: ['stripe'] }),
    null,
  );
});

test('a bare npm install (no package) installs nothing new', () => {
  assert.equal(runGate(bash('npm install')), null);
});

test('flags are skipped, version suffixes stripped, scoped names handled', () => {
  assert.equal(runGate(bash('npm i -D @types/node@20')), null);
  const result = runGate(bash('pnpm add -w @acme/widgets@^2.0.0 axios@1'));
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /@acme\/widgets, axios/);
});

test('yarn add and bun add are recognized; a package already in package.json is not new', () => {
  const files = { 'package.json': STRIPE_ONLY };
  assert.equal(runGate(bash('yarn add stripe'), { files }), null);
  assert.ok(isDeny(runGate(bash('bun add stripe && npm test'))));
});

// ── Robustness ──────────────────────────────────────────────────────────────────────
test('a null content field never crashes into a deny', () => {
  assert.equal(
    runGate({
      tool_name: 'Write',
      tool_input: { file_path: 'package.json', content: null },
    }),
    null,
  );
});

test('a dependencies field that is not an object is ignored (no phantom 0,1,2 deps)', () => {
  assert.equal(
    runGate(writePackageJson(JSON.stringify({ dependencies: 'oops' }))),
    null,
  );
  assert.equal(
    runGate(writePackageJson(JSON.stringify({ dependencies: ['a', 'b'] }))),
    null,
  );
});

test('a non-array depsWithoutOwnApi falls back to the defaults instead of throwing', () => {
  const config = {
    gates: {
      requireSkillForNewDependency: {
        enabled: true,
        depsWithoutOwnApi: 'clsx',
      },
    },
  };
  const result = runGate(
    writePackageJson(JSON.stringify({ dependencies: { clsx: '1' } })),
    { config },
  );
  assert.ok(!isDeny(result), 'clsx stays exempt via the built-in default');
});

test('only a file NAMED package.json is inspected (foo-package.json is not)', () => {
  assert.equal(runGate(write('foo-package.json', STRIPE_ONLY)), null);
});

test('the skills directory is resolved from the project root, not the cwd', () => {
  const project = makeProject({ prefix: 'dependency-skills-' });
  mkdirSync(join(project, '.claude', 'skills', 'stripe'), { recursive: true });
  const sub = join(project, 'packages', 'app');
  mkdirSync(sub, { recursive: true });
  assert.equal(
    runGateProcess(GATE, writePackageJson(STRIPE_ONLY), {
      project,
      cwd: sub,
    }),
    null,
  );
});

test('a skill directory that is a junction/symlink still counts', () => {
  const project = makeProject({ prefix: 'dependency-skills-' });
  const target = join(project, 'elsewhere', 'stripe');
  mkdirSync(target, { recursive: true });
  const skills = join(project, '.claude', 'skills');
  mkdirSync(skills, { recursive: true });
  try {
    symlinkSync(target, join(skills, 'stripe'), 'junction');
  } catch {
    return; // no symlink privilege on this machine: nothing to verify here
  }
  writeFileSync(join(target, 'SKILL.md'), '# stripe');
  assert.equal(
    runGateProcess(GATE, writePackageJson(STRIPE_ONLY), { project }),
    null,
  );
});
