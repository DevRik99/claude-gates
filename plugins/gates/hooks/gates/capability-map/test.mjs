import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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

/** Runs the gate against an already-set-up project directory, under a fresh empty fake
 * home (so the real machine's ~/.claude never leaks in). Returns a `run()` closure so a
 * test can invoke the gate multiple times against the same project/home to observe
 * throttling or fingerprint-change behavior across runs. */
function runnerFor(project) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'capability-map-home-'));
  return () =>
    execFileSync(process.execPath, [GATE], {
      input: JSON.stringify({ cwd: project }),
      encoding: 'utf8',
      cwd: project,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
}

test('on by default: injects with no config declared at all', () => {
  const { out } = runGate({
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  assert.match(out, /deploy — Deploys/);
});

test('explicit enabled:false silences the gate even though it is on by default', () => {
  assert.equal(
    runGate({
      config: { gates: { injectCapabilityMap: false } },
      skills: [{ name: 'deploy', description: 'Deploys.' }],
    }).out,
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

test('truncation breaks at a word boundary, not mid-word', () => {
  const { out } = runGate({
    config: {
      gates: { injectCapabilityMap: { enabled: true, maxClauseChars: 30 } },
    },
    skills: [
      {
        name: 'a11y',
        description: 'Referencia normativa de accesibilidad web completa',
      },
    ],
  });
  const line = out.split('\n').find((l) => l.includes('a11y —'));
  // "accesibilidad" does not fit whole at 30 chars: a mid-word cut would produce
  // something like "…accesibi…"; the word-boundary cut instead stops at the last whole
  // word that fits ("de") and never splits a word in half.
  assert.doesNotMatch(line, /accesibi…$/);
  assert.match(line, /\bde…$/);
});

test('a blurb override is used verbatim instead of mechanical truncation', () => {
  const project = mkdtempSync(join(tmpdir(), 'capability-map-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(ENABLED));
  writeFileSync(
    join(project, '.ai', 'blurb-overrides.json'),
    JSON.stringify({ a11y: 'Doctrina WCAG 2.2 corta y con esencia' }),
  );
  const skillDirectory = join(project, '.claude', 'skills', 'a11y');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    '---\nname: a11y\ndescription: Referencia normativa completa de accesibilidad web con mucho detalle que no entra\n---\n',
  );
  const out = runnerFor(project)();
  assert.match(out, /a11y — Doctrina WCAG 2\.2 corta y con esencia/);
});

test('adding an override AFTER the map was already cached invalidates the cache (regression: overrides file was not fingerprinted, so a cached run kept serving the stale mechanically-truncated blurb forever)', () => {
  const project = mkdtempSync(join(tmpdir(), 'capability-map-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(ENABLED));
  const skillDirectory = join(project, '.claude', 'skills', 'a11y');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    '---\nname: a11y\ndescription: Referencia normativa completa de accesibilidad web con mucho detalle que no entra\n---\n',
  );
  const run = runnerFor(project);

  const first = run(); // no override yet: mechanical truncation
  assert.doesNotMatch(first, /Doctrina WCAG/);

  // The skill file itself is untouched — only the overrides file is added. Without the
  // overrides file in the fingerprint, the persisted catalog's fingerprint would still
  // match and the stale (un-overridden) blurb would keep being served.
  writeFileSync(
    join(project, '.ai', 'blurb-overrides.json'),
    JSON.stringify({ a11y: 'Doctrina WCAG 2.2 corta y con esencia' }),
  );
  const second = run();
  assert.match(second, /a11y — Doctrina WCAG 2\.2 corta y con esencia/);

  const mapPath = join(project, '.ai', 'capability-map.json');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  assert.equal(
    map.capabilities.skills.find((s) => s.name === 'a11y').blurb,
    'Doctrina WCAG 2.2 corta y con esencia',
  );
});

test('throttling: only the Nth message injects; disk-unchanged runs in between are silent', () => {
  const project = mkdtempSync(join(tmpdir(), 'capability-map-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: {
        injectCapabilityMap: { enabled: true, injectEveryMessages: 3 },
      },
    }),
  );
  const skillDirectory = join(project, '.claude', 'skills', 'deploy');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploys.\n---\n',
  );
  const run = runnerFor(project);

  const first = run(); // first run ever: always injects (nothing has been shown yet)
  assert.match(first, /deploy — Deploys/);
  const second = run(); // disk unchanged, counter at 1 of 3: silent
  assert.equal(second, '');
  const third = run(); // counter at 2 of 3: still silent
  assert.equal(third, '');
  const fourth = run(); // counter reaches 3: injects again, resets
  assert.match(fourth, /deploy — Deploys/);
});

test('a removed skill disappears from the persisted map on the next run (fingerprint changed)', () => {
  const project = mkdtempSync(join(tmpdir(), 'capability-map-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(ENABLED));
  const skillsRoot = join(project, '.claude', 'skills');
  const keepDirectory = join(skillsRoot, 'keep');
  const dropDirectory = join(skillsRoot, 'drop');
  mkdirSync(keepDirectory, { recursive: true });
  mkdirSync(dropDirectory, { recursive: true });
  writeFileSync(
    join(keepDirectory, 'SKILL.md'),
    '---\nname: keep\ndescription: Keeps.\n---\n',
  );
  writeFileSync(
    join(dropDirectory, 'SKILL.md'),
    '---\nname: drop\ndescription: Drops.\n---\n',
  );
  const run = runnerFor(project);

  const first = run();
  assert.match(first, /keep — Keeps/);
  assert.match(first, /drop — Drops/);

  rmSync(dropDirectory, { recursive: true, force: true });
  const second = run(); // fingerprint changed (a source file disappeared): forces injection
  assert.match(second, /keep — Keeps/);
  assert.doesNotMatch(second, /drop/);

  const mapPath = join(project, '.ai', 'capability-map.json');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  assert.equal(map.capabilities.skills.length, 1);
  assert.equal(map.capabilities.skills[0].name, 'keep');
});
