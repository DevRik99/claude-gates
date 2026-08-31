import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config, skills } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'dependency-skills-edge-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  if (skills) {
    for (const name of skills) {
      mkdirSync(join(project, '.claude', 'skills', name), { recursive: true });
    }
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isWarn(result) {
  // The gate now DENIES rather than warns; the helper keeps its name but checks the deny.
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

function writePackageJson(content) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: '/repo/package.json', content },
  };
}

// FIXED: skillNameMatches no longer does bidirectional substring matching. A skill dir must
// EQUAL the dependency or contain it as a whole `-`-segment, so an unrelated short name like
// "rip" no longer satisfies "stripe" — the gate now correctly warns (no false exemption).
test('FIXED: an unrelated skill directory name that is a substring of the dependency no longer satisfies the check', () => {
  const package_ = JSON.stringify({ dependencies: { stripe: '1.0.0' } });
  const result = runGate(writePackageJson(package_), { skills: ['rip'] });
  assert.ok(
    isWarn(result),
    'unrelated skill dir "rip" must NOT satisfy dependency "stripe"; the gate warns',
  );
});

test('OK: a genuinely matching skill segment still exempts (stripe-payments covers stripe)', () => {
  const package_ = JSON.stringify({ dependencies: { stripe: '1.0.0' } });
  const result = runGate(writePackageJson(package_), {
    skills: ['stripe-payments'],
  });
  assert.equal(
    result,
    null,
    'a skill whose name contains the dependency as a segment still covers it',
  );
});

// FIXED: content is now read through writtenContentOf, which covers write_to_file's `text`
// field (and every other native/MCP shape). An unreviewed new dependency written via an MCP
// write tool is no longer silently skipped.
test('FIXED: write_to_file with a different content field name is now checked', () => {
  const package_ = JSON.stringify({ dependencies: { stripe: '1.0.0' } });
  const result = runGate({
    tool_name: 'write_to_file',
    tool_input: { file_path: '/repo/package.json', text: package_ },
  });
  assert.ok(
    isWarn(result),
    'the new dependency written via write_to_file (text field) must now be caught',
  );
});
