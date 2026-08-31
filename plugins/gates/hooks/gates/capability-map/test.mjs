import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

/**
 * Runs the UserPromptSubmit gate against a scratch project. `skills`, `agents`, `commands`
 * seed the project-local ~/.claude-style dirs. Returns { out, project } so a test can also
 * inspect the persisted map.
 */
function runGate({ config, skills = [], agents = [], commands = [] } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'capability-map-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  for (const skill of skills) {
    const directory = join(project, '.claude', 'skills', skill.name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: ${skill.description ?? ''}\n---\n# ${skill.name}\n`,
    );
  }
  const agentsDirectory = join(project, '.claude', 'agents');
  for (const agent of agents) {
    mkdirSync(agentsDirectory, { recursive: true });
    // Agents may omit `name` (then the basename is used); honor an explicit one when given.
    const front = agent.name
      ? `---\nname: ${agent.name}\ndescription: ${agent.description ?? ''}\n---\n`
      : `---\ndescription: ${agent.description ?? ''}\n---\n`;
    writeFileSync(join(agentsDirectory, `${agent.file}.md`), front);
  }
  const commandsDirectory = join(project, '.claude', 'commands');
  for (const command of commands) {
    mkdirSync(commandsDirectory, { recursive: true });
    writeFileSync(
      join(commandsDirectory, `${command.file}.${command.ext ?? 'md'}`),
      `---\ndescription: ${command.description ?? ''}\n---\n`,
    );
  }
  // Empty fake home so the real machine's ~/.claude never leaks into expected output.
  const fakeHome = mkdtempSync(join(tmpdir(), 'capability-map-home-'));
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify({ cwd: project }),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  });
  return { out, project };
}

const ENABLED = { gates: { injectCapabilityMap: true } };

test('opt-in: silent when config does not enable the gate', () => {
  assert.equal(
    runGate({ skills: [{ name: 'deploy', description: 'Deploys.' }] }).out,
    '',
  );
});

test('injects skills, agents and commands grouped by kind', () => {
  const { out } = runGate({
    config: ENABLED,
    skills: [{ name: 'deploy', description: 'Deploys the app. Extra detail.' }],
    agents: [{ file: 'backend', name: 'backend', description: 'Server code.' }],
    commands: [{ file: 'review', description: 'Reviews the diff.' }],
  });
  assert.match(out, /\[capabilities\] available/);
  assert.match(out, /skills:/);
  assert.match(out, /deploy — Deploys the app/);
  assert.doesNotMatch(out, /Extra detail/); // second clause dropped
  assert.match(out, /agents:/);
  assert.match(out, /backend — Server code/);
  assert.match(out, /commands:/);
  assert.match(out, /review — Reviews the diff/);
});

test('an agent without a name falls back to its file basename', () => {
  const { out } = runGate({
    config: ENABLED,
    agents: [{ file: 'my-agent', description: 'Does a thing.' }],
  });
  assert.match(out, /my-agent — Does a thing/);
});

test('a .toml command is discovered like a .md one', () => {
  const { out } = runGate({
    config: ENABLED,
    commands: [{ file: 'ship', ext: 'toml', description: 'Ships it.' }],
  });
  assert.match(out, /ship — Ships it/);
});

test('persists the catalog to .ai/capability-map.json', () => {
  const { project } = runGate({
    config: ENABLED,
    skills: [{ name: 'deploy', description: 'Deploys.' }],
    agents: [{ file: 'qa', name: 'qa', description: 'Checks it.' }],
  });
  const mapPath = join(project, '.ai', 'capability-map.json');
  assert.ok(existsSync(mapPath), 'map file should be written');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  assert.equal(map.capabilities.skills[0].name, 'deploy');
  assert.equal(map.capabilities.agents[0].name, 'qa');
  assert.ok(map.generatedAt);
});

test('persist:false suppresses the map file but still injects', () => {
  const { out, project } = runGate({
    config: {
      gates: { injectCapabilityMap: { enabled: true, persist: false } },
    },
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  assert.match(out, /deploy — Deploys/);
  assert.ok(!existsSync(join(project, '.ai', 'capability-map.json')));
});

test('kinds override: only the named kinds are scanned', () => {
  const { out } = runGate({
    config: {
      gates: { injectCapabilityMap: { enabled: true, kinds: ['agents'] } },
    },
    skills: [{ name: 'deploy', description: 'Deploys.' }],
    agents: [{ file: 'backend', name: 'backend', description: 'Server code.' }],
  });
  assert.match(out, /backend — Server code/);
  assert.doesNotMatch(out, /deploy/); // skills kind excluded
  assert.doesNotMatch(out, /skills:/);
});

test('autosync: a newly added agent appears without any code change', () => {
  const first = runGate({
    config: ENABLED,
    agents: [{ file: 'backend', name: 'backend', description: 'Server.' }],
  }).out;
  assert.doesNotMatch(first, /frontend/);
  const second = runGate({
    config: ENABLED,
    agents: [
      { file: 'backend', name: 'backend', description: 'Server.' },
      { file: 'frontend', name: 'frontend', description: 'UI code.' },
    ],
  }).out;
  assert.match(second, /frontend — UI code/);
});

test('silent when enabled but nothing exists anywhere', () => {
  assert.equal(runGate({ config: ENABLED }).out, '');
});

test('caveman cap: a long single-clause blurb is truncated', () => {
  const long = 'x'.repeat(200);
  const { out } = runGate({
    config: {
      gates: { injectCapabilityMap: { enabled: true, maxClauseChars: 20 } },
    },
    skills: [{ name: 'big', description: long }],
  });
  const line = out.split('\n').find((l) => l.includes('big —'));
  assert.ok(line.trim().length < 40, `line should be capped, got "${line}"`);
  assert.match(line, /…$/);
});
