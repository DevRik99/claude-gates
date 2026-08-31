import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function newProject({ config, git = true } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'test-after-implementation-edge-'));
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
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function writeTest(filePath) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content: 'test content' } };
}
function isWarn(result) {
  // The gate now DENIES rather than warns; the helper keeps its name but checks the deny.
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLE = { gates: { warnTestWrittenAfterImplementation: true } };

// EDGE CASE (BUG): the paired-implementation match requires the changed file's directory
// (relative to cwd) to equal the test file's directory exactly (index.mjs line 83-86). A
// common layout keeps tests in a sibling __tests__/ directory next to the implementation —
// this gate then never pairs them, silently missing the exact case (tests-after-impl) it
// exists to catch.
test('BUG: false negative — implementation and test in different conventional directories (src/ vs __tests__/) are never paired', () => {
  const project = newProject({ config: ENABLE });
  mkdirSync(join(project, 'src'));
  mkdirSync(join(project, '__tests__'));
  writeFileSync(join(project, 'src', 'thing.js'), 'export const thing = 1;');
  const testPath = join(project, '__tests__', 'thing.test.js');
  const result = runGateIn(project, writeTest(testPath));
  assert.equal(result, null, 'gate misses the exact case it targets because dirname(test) !== dirname(impl) under a __tests__/ layout');
});

// EDGE CASE (BUG): only `git status --porcelain` (uncommitted changes) is checked. If the
// implementation was written AND COMMITTED before writing the test (a slightly worse
// practice: commit-then-test rather than just write-then-test), git status shows nothing
// changed and the gate never warns — the temporal violation it targets still happened but
// leaves no trace once committed.
test('BUG: false negative — once the paired implementation change is committed, the warning never fires even though tests were still written strictly after', () => {
  const project = newProject({ config: ENABLE });
  writeFileSync(join(project, 'thing.js'), 'export const thing = 1;');
  execFileSync('git', ['add', '-A'], { cwd: project });
  execFileSync('git', ['commit', '-q', '-m', 'implement thing'], { cwd: project });
  const testPath = join(project, 'thing.test.js');
  const result = runGateIn(project, writeTest(testPath));
  assert.equal(result, null, 'committing the implementation first launders the same temporal violation past a git-status-based check');
});
