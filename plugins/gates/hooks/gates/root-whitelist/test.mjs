import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Creates a fresh temp project (with .git so it is recognized as a root, and an optional
// .ai/config.json) and returns its path plus a `run` function that executes the gate with
// that project as cwd, building the write target relative to it. This keeps the file path
// the gate inspects and the cwd it resolves against always in sync.
function project({ config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'root-whitelist-'));
  mkdirSync(join(root, '.git'));
  if (config) {
    mkdirSync(join(root, '.ai'));
    writeFileSync(join(root, '.ai', 'config.json'), JSON.stringify(config));
  }
  return {
    root,
    run(payload) {
      const out = execFileSync(process.execPath, [GATE], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: root,
        // Isolate from the user's real global config: point homedir() at the temp
        // project so the global-config fallback finds nothing (registry default).
        env: { ...process.env, HOME: root, USERPROFILE: root },
      });
      return out.trim() ? JSON.parse(out.trim()) : null;
    },
  };
}

function write(root, relativePath) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: join(root, relativePath) },
  };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('denies an orphan root file and an undeclared root folder', () => {
  const { root, run } = project();
  assert.ok(isDeny(run(write(root, 'random-orphan.txt'))));
  assert.ok(isDeny(run(write(root, join('random-folder', 'a.js')))));
});

test('allows a whitelisted root file, a whitelisted folder and a dotfile', () => {
  const { root, run } = project();
  assert.equal(run(write(root, 'package.json')), null);
  assert.equal(run(write(root, join('src', 'index.js'))), null);
  assert.equal(run(write(root, '.env')), null);
});

test('allows the common framework root folders that the old narrow list wrongly blocked', () => {
  // Regression: the previous whitelist only had src/tests/docs/scripts/plugins, so a real
  // project creating app/ (Next/Nuxt/Laravel/Expo), lib/, public/, components/, pages/, api/
  // was blocked at the root. Those are legitimate structural folders and must pass.
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
      run(write(root, join(folder, 'thing.js'))),
      null,
      `root folder '${folder}' must be allowed`,
    );
  }
});

test('disabled by config: the gate does not run', () => {
  const config = { gates: { blockPathsOutsideRootWhitelist: false } };
  const { root, run } = project({ config });
  assert.equal(run(write(root, 'random-orphan.txt')), null);
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
  // 'src' no longer whitelisted under the override
  assert.ok(isDeny(run(write(root, join('src', 'index.js')))));
  assert.equal(run(write(root, join('app', 'index.js'))), null);
});
