import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  isDeny,
  isWarn,
  makeProject,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ENABLE = { gates: { autodiscoverRulesAndSkills: true } };

function newProject({ config = ENABLE, rule } = {}) {
  const project = makeProject({
    prefix: 'rule-skill-autodiscovery-',
    config: config ?? undefined,
  });
  if (rule !== undefined) {
    mkdirSync(join(project, 'rules'));
    writeFileSync(join(project, 'rules', 'gate.mjs'), rule);
  }
  return project;
}

function runGateIn(project, payload = bash('npm run build'), options = {}) {
  return runGateProcess(GATE, payload, { project, ...options });
}

test('a rule script that exits 2 denies with its stderr as the reason', () => {
  const project = newProject({
    rule: 'console.error("Error: X is not configured"); process.exit(2);',
  });
  const result = runGateIn(project);
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /rules[\\/]gate\.mjs/);
  assert.match(messageOf(result), /Error: X is not configured/);
});

test('a rule script that prints a deny decision as JSON denies with that reason', () => {
  const project = newProject({
    rule: 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no builds on Friday" } }));',
  });
  const result = runGateIn(project);
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /no builds on Friday/);
});

// Assertion updated with the audited behavior: a CRASH (non-zero exit that is not 2) is
// a broken script, which warns instead of blocking every call.
test('a rule script that crashes (exit 1) WARNS with the script path, exit code and stderr — it does not deny', () => {
  const project = newProject({
    rule: 'console.error("Error: X is not configured"); process.exit(1);',
  });
  const result = runGateIn(project);
  assert.ok(!isDeny(result));
  assert.ok(isWarn(result));
  assert.match(messageOf(result), /rules[\\/]gate\.mjs/);
  assert.match(messageOf(result), /exit 1/);
  assert.match(messageOf(result), /Error: X is not configured/);
});

test('allows when discovered rule scripts succeed', () => {
  const project = newProject({ rule: 'process.exit(0);' });
  assert.equal(runGateIn(project), null);
});

test('discovers gate files inside .claude/skills subfolders', () => {
  const project = newProject();
  mkdirSync(join(project, '.claude', 'skills', 'my-skill'), {
    recursive: true,
  });
  writeFileSync(
    join(project, '.claude', 'skills', 'my-skill', 'check.mjs'),
    'process.exit(2);',
  );
  assert.ok(isDeny(runGateIn(project)));
});

test('degrades to allow when no rules dir or skills dir exists', () => {
  assert.equal(runGateIn(newProject()), null);
});

test('disabled by default (registry default is false)', () => {
  const project = newProject({ config: null, rule: 'process.exit(2);' });
  assert.equal(runGateIn(project), null);
});

// ── Code execution is a PROJECT decision ────────────────────────────────────────────
test('enabling the gate only in the global config does nothing for a project without its own config', () => {
  const project = newProject({ config: null });
  const marker = join(project, 'ran.txt');
  mkdirSync(join(project, 'rules'));
  writeFileSync(
    join(project, 'rules', 'gate.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(2);`,
  );
  mkdirSync(join(project, '.claude', 'claude-gates'), { recursive: true });
  writeFileSync(
    join(project, '.claude', 'claude-gates', 'config.json'),
    JSON.stringify(ENABLE),
  );
  assert.equal(runGateIn(project), null);
  assert.ok(!existsSync(marker), 'the script must not have executed');
});

// ── What a sub-gate receives ────────────────────────────────────────────────────────
test('a sub-gate receives the hook payload on stdin', () => {
  const project = newProject({
    rule: [
      "import { readFileSync } from 'node:fs';",
      "const payload = JSON.parse(readFileSync(0, 'utf8'));",
      "if (payload.tool_name === 'Bash') { console.error('bash is not allowed here'); process.exit(2); }",
      'process.exit(0);',
    ].join('\n'),
  });
  const denied = runGateIn(project, bash('npm run build'));
  assert.ok(isDeny(denied));
  assert.match(messageOf(denied), /bash is not allowed here/);
  assert.equal(
    runGateIn(project, { tool_name: 'Agent', tool_input: { prompt: 'x' } }),
    null,
  );
});

test('a sub-gate runs from the project root, even when the hook cwd is a subdirectory', () => {
  const project = newProject({
    rule: [
      "import { existsSync } from 'node:fs';",
      "if (!existsSync('rules/gate.mjs')) { console.error('wrong cwd'); process.exit(2); }",
      'process.exit(0);',
    ].join('\n'),
  });
  const sub = join(project, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.equal(runGateIn(project, bash('npm run build'), { cwd: sub }), null);
});

test('a sub-gate gets a restricted environment (no arbitrary variables leak in)', () => {
  const project = newProject({
    rule: [
      "if (process.env.SECRET_TOKEN) { console.error('leaked'); process.exit(2); }",
      "if (!process.env.CLAUDE_GATES_LOG) { console.error('CLAUDE_* missing'); process.exit(2); }",
      'process.exit(0);',
    ].join('\n'),
  });
  assert.equal(
    runGateIn(project, bash('npm run build'), {
      environment: { SECRET_TOKEN: 'hunter2' },
    }),
    null,
  );
});

// ── Robustness ──────────────────────────────────────────────────────────────────────
test('a hanging sub-gate is cut by the shared 8 s budget and WARNS instead of denying', () => {
  const project = newProject({ rule: 'while (true) {}' });
  const start = Date.now();
  const result = runGateIn(project);
  const elapsedMs = Date.now() - start;
  assert.ok(!isDeny(result));
  assert.ok(isWarn(result));
  assert.match(messageOf(result), /timed out/);
  assert.ok(elapsedMs < 14000, `took ${elapsedMs}ms`);
});

test('a sub-gate in a skill directory that is a junction/symlink is discovered', () => {
  const project = newProject();
  const target = join(project, 'elsewhere', 'linked-skill');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'check.mjs'), 'process.exit(2);');
  const skills = join(project, '.claude', 'skills');
  mkdirSync(skills, { recursive: true });
  try {
    symlinkSync(target, join(skills, 'linked-skill'), 'junction');
  } catch {
    return; // no symlink privilege on this machine: nothing to verify here
  }
  assert.ok(isDeny(runGateIn(project)));
});
