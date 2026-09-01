import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

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

function newProject({ config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'rule-skill-autodiscovery-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  return project;
}

function exec() {
  return { tool_name: 'Bash', tool_input: { command: 'echo hi' } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLE = { gates: { ['autodiscoverRulesAndSkills']: true } };

test('denies when a discovered rule script fails', () => {
  const project = newProject({ config: ENABLE });
  mkdirSync(join(project, 'rules'));
  writeFileSync(join(project, 'rules', 'gate.mjs'), 'process.exit(1);');
  assert.ok(isDeny(runGateIn(project, exec())));
});

test('the deny message includes the failing script path, exit code, and its stderr output — not a bare "Sub-gate failed"', () => {
  // Regression: stdio was 'ignore' for the sub-gate's stderr, so a genuinely useful error
  // message from the script itself (e.g. "Error: X is not configured") was thrown away and
  // the deny said nothing more than "Sub-gate failed: rules/gate.mjs. Fix it." — leaving no
  // way to know WHAT was wrong without opening and re-running the script by hand.
  const project = newProject({ config: ENABLE });
  mkdirSync(join(project, 'rules'));
  writeFileSync(
    join(project, 'rules', 'gate.mjs'),
    'console.error("Error: X is not configured"); process.exit(1);',
  );
  const result = runGateIn(project, exec());
  assert.ok(isDeny(result));
  const reason = result.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /rules[\\/]gate\.mjs/);
  assert.match(reason, /Error: X is not configured/);
});

test('allows when discovered rule scripts succeed', () => {
  const project = newProject({ config: ENABLE });
  mkdirSync(join(project, 'rules'));
  writeFileSync(join(project, 'rules', 'gate.mjs'), 'process.exit(0);');
  assert.equal(runGateIn(project, exec()), null);
});

test('discovers gate files inside .claude/skills subfolders', () => {
  const project = newProject({ config: ENABLE });
  mkdirSync(join(project, '.claude', 'skills', 'my-skill'), {
    recursive: true,
  });
  writeFileSync(
    join(project, '.claude', 'skills', 'my-skill', 'check.mjs'),
    'process.exit(1);',
  );
  assert.ok(isDeny(runGateIn(project, exec())));
});

test('degrades to allow when no rules dir or skills dir exists', () => {
  const project = newProject({ config: ENABLE });
  assert.equal(runGateIn(project, exec()), null);
});

test('disabled by default (registry default is false)', () => {
  const project = newProject();
  mkdirSync(join(project, 'rules'));
  writeFileSync(join(project, 'rules', 'gate.mjs'), 'process.exit(1);');
  assert.equal(runGateIn(project, exec()), null);
});
