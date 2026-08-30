// Edge-case audit for root-whitelist: bypasses and false positives.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function project({ config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'root-whitelist-edge-'));
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
        env: { ...process.env, HOME: root, USERPROFILE: root },
      });
      return out.trim() ? JSON.parse(out.trim()) : null;
    },
  };
}

function write(filePath) {
  return { tool_name: 'Write', tool_input: { file_path: filePath } };
}
function mcpTool(name, input) {
  return { tool_name: name, tool_input: input };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

// ── FIXED: toolInGroups classifies an MCP tool by its action segment, so an MCP write
// tool creating an orphan root file is now recognized.
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

// ── FIXED: a relative (non-absolute) file_path is now resolved against process.cwd()
// (the test runs the gate with cwd = root) before the root-prefix check, so it is judged
// by where it actually lands instead of skipping the check entirely.
test('FIXED: a relative file_path targeting the root is now caught by resolving it against cwd', () => {
  const { run } = project();
  const result = run(write('orphan-relative.txt'));
  assert.ok(isDeny(result));
});

// ── BUG candidate: path traversal via ../ that resolves back into the root from a
// nested absolute path, e.g. '<root>/src/../orphan.txt'. normalize() collapses '..'
// segments, so this SHOULD reduce to '<root>/orphan.txt' and be caught. Confirm.
test('OK: a traversal path that normalizes back to the root is still caught', () => {
  const { root, run } = project();
  const result = run(write(join(root, 'src', '..', 'orphan-traversal.txt')));
  assert.ok(isDeny(result));
});

// ── BUG candidate: a whitelisted root FOLDER name used as a FILE at the root, e.g.
// creating a file literally named 'src' (no extension) at the root. relativePath has no
// sep, so it goes through the FILE branch and checks filesWhitelist, not
// foldersWhitelist — 'src' is not in rootFilesWhitelist, so this is correctly denied,
// not a bug. Confirm.
test('OK: a root-level file named identically to a whitelisted folder is still denied under the file whitelist', () => {
  const { root, run } = project();
  const result = run(write(join(root, 'src')));
  assert.ok(isDeny(result));
});

// ── FIXED: case-sensitivity. rootFilesWhitelist/rootFoldersWhitelist membership is now
// compared lowercase on both sides, so 'Package.json' is recognized as the same entry as
// the whitelisted 'package.json' — no more false positive on case-insensitive filesystems.
test('FIXED: a root file matching the whitelist except for letter case is now allowed', () => {
  const { root, run } = project();
  const result = run(write(join(root, 'Package.json')));
  assert.equal(result, null);
});

// ── BUG candidate: an MCP "write" tool with a `path` field only (not `file_path`,
// `TargetFile`, or `target_file`) — writeTargetFrom does not recognize `path` alone
// unless the tool is also in WRITE_TOOLS. Since MCP tools already fail the toolName
// check, this compounds the same root bug; not a separate one worth a distinct test.
