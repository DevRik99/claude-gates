import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// A scratch project plus a runner bound to it, so the path the gate inspects and the root it
// resolves against always agree.
function project({ config, cwd } = {}) {
  const root = makeProject({ prefix: 'root-whitelist-', config });
  return {
    root,
    run(payload, options = {}) {
      return runGateProcess(GATE, payload, {
        project: root,
        cwd: cwd ? join(root, cwd) : root,
        ...options,
      });
    },
  };
}

function writeAt(root, relativePath) {
  return write(join(root, relativePath));
}

test('denies an orphan root file and an undeclared root folder', () => {
  const { root, run } = project();
  assert.ok(isDeny(run(writeAt(root, 'random-orphan.txt'))));
  assert.ok(isDeny(run(writeAt(root, join('random-folder', 'a.js')))));
});

test('allows a whitelisted root file, a whitelisted folder and a dotfile', () => {
  const { root, run } = project();
  assert.equal(run(writeAt(root, 'package.json')), null);
  assert.equal(run(writeAt(root, join('src', 'index.js'))), null);
  assert.equal(run(writeAt(root, '.env')), null);
});

test('allows the common framework root folders that the old narrow list wrongly blocked', () => {
  const { root, run } = project();
  for (const folder of [
    'app',
    'lib',
    'public',
    'components',
    'pages',
    'api',
    'packages',
    'dist',
    'assets',
  ]) {
    assert.equal(
      run(writeAt(root, join(folder, 'thing.js'))),
      null,
      `root folder '${folder}' must be allowed`,
    );
  }
});

test('disabled by config: the gate does not run', () => {
  const config = { gates: { blockPathsOutsideRootWhitelist: false } };
  const { root, run } = project({ config });
  assert.equal(run(writeAt(root, 'random-orphan.txt')), null);
});

test('project rootFoldersWhitelist replaces the built-in list', () => {
  const config = {
    gates: {
      blockPathsOutsideRootWhitelist: {
        enabled: true,
        rootFoldersWhitelist: ['app'],
      },
    },
  };
  const { root, run } = project({ config });
  assert.ok(isDeny(run(writeAt(root, join('src', 'index.js')))));
  assert.equal(run(writeAt(root, join('app', 'index.js'))), null);
});

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('editing a root file that already exists is allowed even when unwhitelisted', () => {
  const { root, run } = project();
  for (const name of [
    'registry.json',
    'CHANGELOG.md',
    'yarn.lock',
    'Makefile',
  ]) {
    writeFileSync(join(root, name), 'x');
    assert.equal(run(writeAt(root, name)), null, `${name} exists: an edit`);
  }
  assert.ok(isDeny(run(writeAt(root, 'brand-new.json'))));
});

test('a nested path under a root folder that already exists is allowed', () => {
  const { root, run } = project();
  mkdirSync(join(root, 'random-folder'));
  assert.equal(run(writeAt(root, join('random-folder', 'a.js'))), null);
});

test('the root is the project root, not the cwd: judged the same from a subfolder', () => {
  const { root, run } = project({ cwd: 'sub' });
  mkdirSync(join(root, 'sub'));
  assert.ok(
    isDeny(run(writeAt(root, 'orphan.txt'))),
    'a root orphan written from <root>/sub is still an orphan',
  );
  assert.equal(
    run(writeAt(root, join('sub', 'file.txt'))),
    null,
    'a file inside the subfolder is not at the root',
  );
});

test(
  'a lowercase drive letter or a git-bash /c/ path is the same root',
  { skip: process.platform !== 'win32' },
  () => {
    const { root, run } = project();
    const lowerDrive = root[0].toLowerCase() + root.slice(1);
    assert.ok(isDeny(run(write(join(lowerDrive, 'orphan.txt')))));
    const gitBash = `/${root[0].toLowerCase()}/${root.slice(3).replace(/\\/g, '/')}/orphan.txt`;
    assert.ok(isDeny(run(write(gitBash))));
  },
);

test('every shell form that creates a root entry is judged', () => {
  const { run } = project();
  for (const command of [
    'echo hi>orphan.txt',
    'echo x > "orphan file.txt"',
    'mkdir newdir',
    'git clone https://example.test/x/y.git newrepo',
    'git clone https://example.test/x/newrepo.git',
    'curl -o dump.json http://example.test',
    'New-Item orphan.txt',
    'New-Item -ItemType Directory newdir',
    'Set-Content orphan.txt x',
    'Out-File -FilePath orphan.txt',
  ]) {
    assert.ok(isDeny(run(bash(command))), `${command} must be denied`);
  }
});

test('mkdir and git clone at the root are judged as folders', () => {
  const { run } = project();
  assert.equal(run(bash('mkdir src')), null, 'src is a whitelisted folder');
  assert.equal(run(bash('git clone https://example.test/x/docs.git')), null);
  const result = run(bash('mkdir newdir'));
  assert.match(messageOf(result), /Folder 'newdir'/);
  assert.match(messageOf(result), /rootFoldersWhitelist/);
});

test('a copy whose destination is outside the root, or into a whitelisted folder, is allowed', () => {
  const { root, run } = project();
  writeFileSync(join(root, 'registry.json'), '{}');
  assert.equal(run(bash('cp registry.json /tmp/backup.json')), null);
  assert.equal(run(bash('mv old.txt src/')), null);
});
