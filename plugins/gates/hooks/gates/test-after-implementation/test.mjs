import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function newProject({ config, git = true } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'test-after-implementation-'));
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: project });
    execFileSync('git', ['config', 'user.name', 'a'], { cwd: project });
  }
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  return project;
}

function runGateIn(project, payload) {
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function writeTest(filePath) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'test content' },
  };
}
function isWarn(result) {
  // The gate now DENIES rather than warns; the helper keeps its name but checks the deny.
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLE = { gates: { warnTestWrittenAfterImplementation: true } };

test('warns when creating a test whose paired implementation was just modified (uncommitted)', () => {
  const project = newProject({ config: ENABLE });
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  const testPath = join(project, 'thing.test.js');
  assert.ok(isWarn(runGateIn(project, writeTest(testPath))));
});

test('allows creating a test with no paired uncommitted implementation', () => {
  const project = newProject({ config: ENABLE });
  const testPath = join(project, 'unrelated.test.js');
  assert.equal(runGateIn(project, writeTest(testPath)), null);
});

test('allows editing (not creating) an existing test file', () => {
  const project = newProject({ config: ENABLE });
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  const testPath = join(project, 'thing.test.js');
  writeFileSync(testPath, 'existing test');
  assert.equal(runGateIn(project, writeTest(testPath)), null);
});

test('degrades to allow when not a git repo', () => {
  const project = newProject({ config: ENABLE, git: false });
  const testPath = join(project, 'thing.test.js');
  assert.equal(runGateIn(project, writeTest(testPath)), null);
});

test('disabled by default (registry default is false)', () => {
  const project = newProject();
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  const testPath = join(project, 'thing.test.js');
  assert.equal(runGateIn(project, writeTest(testPath)), null);
});
