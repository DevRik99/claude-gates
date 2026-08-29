import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config, skills } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'dependency-skills-'));
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
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function writePackageJson(content) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: '/repo/package.json', content },
  };
}
function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}

test('warns when a new dependency has no matching skill', () => {
  const package_ = JSON.stringify({ dependencies: { stripe: '1.0.0' } });
  assert.ok(isWarn(runGate(writePackageJson(package_))));
});

test('allows when the dependency has a matching skill directory', () => {
  const package_ = JSON.stringify({ dependencies: { stripe: '1.0.0' } });
  assert.equal(
    runGate(writePackageJson(package_), { skills: ['stripe'] }),
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
  assert.equal(
    runGate({
      tool_name: 'Write',
      tool_input: { file_path: '/repo/src/index.js', content: 'x' },
    }),
    null,
  );
  assert.equal(
    runGate(writePackageJson('{ "dependencies": { incomplete')),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  const package_ = JSON.stringify({ dependencies: { stripe: '1.0.0' } });
  assert.equal(
    runGate(writePackageJson(package_), {
      config: { gates: { requireSkillForNewDependency: false } },
    }),
    null,
  );
});

test('project projectSkillsDir override is honored', () => {
  const package_ = JSON.stringify({ dependencies: { stripe: '1.0.0' } });
  const config = {
    gates: {
      requireSkillForNewDependency: {
        enabled: true,
        projectSkillsDir: 'custom-skills',
      },
    },
  };
  const project = mkdtempSync(join(tmpdir(), 'dependency-skills-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  mkdirSync(join(project, 'custom-skills', 'stripe'), { recursive: true });
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(writePackageJson(package_)),
    encoding: 'utf8',
    cwd: project,
  });
  assert.equal(out.trim() ? JSON.parse(out.trim()) : null, null);
});
