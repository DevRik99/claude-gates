// adversarial-tests:allow — comment-ok: because this file is the gate's behavior suite, one
// case per injection path (catalog change, pivot, throttle, kinds, overrides).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeProject } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

let sessionCounter = 0;

function writeSkill(root, name, description) {
  const directory = join(root, 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description ?? ''}\n---\n# ${name}\n`,
  );
}

function seedProject(project, { skills = [], agents = [], commands = [] }) {
  const claude = join(project, '.claude');
  for (const skill of skills) writeSkill(claude, skill.name, skill.description);
  for (const agent of agents) {
    mkdirSync(join(claude, 'agents'), { recursive: true });
    const front = agent.name
      ? `---\nname: ${agent.name}\ndescription: ${agent.description ?? ''}\n---\n`
      : `---\ndescription: ${agent.description ?? ''}\n---\n`;
    writeFileSync(join(claude, 'agents', `${agent.file}.md`), front);
  }
  for (const command of commands) {
    mkdirSync(join(claude, 'commands'), { recursive: true });
    writeFileSync(
      join(claude, 'commands', `${command.file}.${command.ext ?? 'md'}`),
      `---\ndescription: ${command.description ?? ''}\n---\n`,
    );
  }
}

/** A runner bound to one project, one fake home (so the real ~/.claude never leaks in)
 * and one session id, so repeated calls observe throttling and cache behavior. */
function runnerFor(project, { home, cwd } = {}) {
  const fakeHome = home ?? mkdtempSync(join(tmpdir(), 'capability-map-home-'));
  sessionCounter += 1;
  const sessionId = `capability-map-test-${process.pid}-${sessionCounter}`;
  return (payload = {}) =>
    execFileSync(process.execPath, [GATE], {
      input: JSON.stringify({
        cwd: cwd ?? project,
        session_id: sessionId,
        ...payload,
      }),
      encoding: 'utf8',
      cwd: cwd ?? project,
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        CLAUDE_GATES_LOG: '0',
      },
    });
}

function runGate({ config, ...seed } = {}) {
  const project = makeProject({ prefix: 'capability-map-', config });
  seedProject(project, seed);
  return { out: runnerFor(project)(), project };
}

const ENABLED = { gates: { injectCapabilityMap: true } };
const MAP_FILE = join('.ai', 'capability-map.json');

test('on by default: injects with no config declared at all', () => {
  const { out } = runGate({
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  assert.match(out, /deploy — Deploys/);
});

test('explicit enabled:false silences the gate even though it is on by default', () => {
  const { out } = runGate({
    config: { gates: { injectCapabilityMap: false } },
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  assert.equal(out, '');
});

test('injects skills, agents and commands grouped by kind', () => {
  const { out } = runGate({
    config: ENABLED,
    skills: [{ name: 'deploy', description: 'Deploys the app. Extra detail.' }],
    agents: [{ file: 'backend', name: 'backend', description: 'Server code.' }],
    commands: [{ file: 'review', description: 'Reviews the diff.' }],
  });
  assert.match(out, /\[injectCapabilityMap\] available capabilities/);
  assert.match(out, /skills:/);
  assert.match(out, /deploy — Deploys the app/);
  assert.doesNotMatch(out, /Extra detail/);
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
  const mapPath = join(project, MAP_FILE);
  assert.ok(existsSync(mapPath));
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
  assert.ok(!existsSync(join(project, MAP_FILE)));
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
  assert.doesNotMatch(out, /deploy/);
  assert.doesNotMatch(out, /skills:/);
});

test('autosync: a newly added agent appears without any code change', () => {
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  seedProject(project, {
    agents: [{ file: 'backend', name: 'backend', description: 'Server.' }],
  });
  const run = runnerFor(project);
  assert.doesNotMatch(run(), /frontend/);
  seedProject(project, {
    agents: [{ file: 'frontend', name: 'frontend', description: 'UI code.' }],
  });
  assert.match(run(), /frontend — UI code/);
});

test('silent when enabled but nothing exists anywhere', () => {
  assert.equal(runGate({ config: ENABLED }).out, '');
});

test('caveman cap: a long single-clause blurb is truncated', () => {
  const { out } = runGate({
    config: {
      gates: { injectCapabilityMap: { enabled: true, maxClauseChars: 20 } },
    },
    skills: [{ name: 'big', description: 'x'.repeat(200) }],
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
  assert.doesNotMatch(line, /accesibi…$/);
  assert.match(line, /\bde…$/);
});

const LONG_A11Y =
  'Referencia normativa completa de accesibilidad web con mucho detalle que no entra';

test('a blurb override is used verbatim instead of mechanical truncation', () => {
  const project = makeProject({
    prefix: 'capability-map-',
    config: ENABLED,
    files: {
      '.ai/blurb-overrides.json': JSON.stringify({
        a11y: 'Doctrina WCAG 2.2 corta y con esencia',
      }),
    },
  });
  seedProject(project, { skills: [{ name: 'a11y', description: LONG_A11Y }] });
  assert.match(
    runnerFor(project)(),
    /a11y — Doctrina WCAG 2\.2 corta y con esencia/,
  );
});

test('adding an override AFTER the map was already cached invalidates the cache', () => {
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  seedProject(project, { skills: [{ name: 'a11y', description: LONG_A11Y }] });
  const run = runnerFor(project);
  assert.doesNotMatch(run(), /Doctrina WCAG/);
  writeFileSync(
    join(project, '.ai', 'blurb-overrides.json'),
    JSON.stringify({ a11y: 'Doctrina WCAG 2.2 corta y con esencia' }),
  );
  assert.match(run(), /a11y — Doctrina WCAG 2\.2 corta y con esencia/);
  const map = JSON.parse(readFileSync(join(project, MAP_FILE), 'utf8'));
  assert.equal(
    map.capabilities.skills.find((s) => s.name === 'a11y').blurb,
    'Doctrina WCAG 2.2 corta y con esencia',
  );
});

test('throttling: only the Nth message injects; disk-unchanged runs in between are silent', () => {
  const project = makeProject({
    prefix: 'capability-map-',
    config: {
      gates: { injectCapabilityMap: { enabled: true, injectEveryMessages: 3 } },
    },
  });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  const run = runnerFor(project);
  assert.match(run(), /deploy — Deploys/);
  assert.equal(run(), '');
  assert.equal(run(), '');
  assert.match(run(), /deploy — Deploys/);
});

test('a removed skill disappears from the persisted map on the next run', () => {
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  seedProject(project, {
    skills: [
      { name: 'keep', description: 'Keeps.' },
      { name: 'drop', description: 'Drops.' },
    ],
  });
  const run = runnerFor(project);
  const first = run();
  assert.match(first, /keep — Keeps/);
  assert.match(first, /drop — Drops/);
  rmSync(join(project, '.claude', 'skills', 'drop'), {
    recursive: true,
    force: true,
  });
  const second = run();
  assert.match(second, /keep — Keeps/);
  assert.doesNotMatch(second, /drop/);
  const map = JSON.parse(readFileSync(join(project, MAP_FILE), 'utf8'));
  assert.deepEqual(
    map.capabilities.skills.map((s) => s.name),
    ['keep'],
  );
});

// ── Config layering through the lib ─────────────────────────────────────────────────
test('the project config layer wins wholesale over the global one (lib semantics)', () => {
  const home = mkdtempSync(join(tmpdir(), 'capability-map-home-'));
  mkdirSync(join(home, '.claude', 'claude-gates'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'claude-gates', 'config.json'),
    JSON.stringify({ gates: { injectCapabilityMap: false } }),
  );
  const project = makeProject({
    prefix: 'capability-map-',
    config: { gates: {} },
  });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  assert.match(runnerFor(project, { home })(), /deploy — Deploys/);
});

test('a non-boolean `enabled` is not truthy-enabled: only the registry default applies', () => {
  const { out } = runGate({
    config: { gates: { injectCapabilityMap: { enabled: 'no' } } },
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  assert.match(out, /deploy — Deploys/);
});

test('a non-string blurb override and a malformed map file never crash the hook', () => {
  const project = makeProject({
    prefix: 'capability-map-',
    config: ENABLED,
    files: {
      '.ai/blurb-overrides.json': JSON.stringify({ deploy: { nested: true } }),
      [MAP_FILE]: '{not json',
    },
  });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  assert.match(runnerFor(project)(), /deploy — Deploys/);
});

// ── Fingerprint covers the settings that shape a blurb ──────────────────────────────
test('changing maxClauseChars re-derives the cached blurbs', () => {
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  seedProject(project, { skills: [{ name: 'a11y', description: LONG_A11Y }] });
  const run = runnerFor(project);
  assert.match(run(), /a11y — Referencia normativa completa/);
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: { injectCapabilityMap: { enabled: true, maxClauseChars: 20 } },
    }),
  );
  const line = run()
    .split('\n')
    .find((l) => l.includes('a11y —'));
  assert.ok(
    line && line.trim().length < 40,
    `expected a re-truncated blurb, got "${line}"`,
  );
});

test('changing kinds re-derives the catalog immediately', () => {
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
    agents: [{ file: 'qa', name: 'qa', description: 'Checks.' }],
  });
  const run = runnerFor(project);
  assert.match(run(), /qa — Checks/);
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: { injectCapabilityMap: { enabled: true, kinds: ['skills'] } },
    }),
  );
  const out = run();
  assert.match(out, /deploy — Deploys/);
  assert.doesNotMatch(out, /qa — Checks/);
});

// ── Roots and shadowing ─────────────────────────────────────────────────────────────
test('a project skill shadows a global skill of the same name', () => {
  const home = mkdtempSync(join(tmpdir(), 'capability-map-home-'));
  writeSkill(join(home, '.claude'), 'deploy', 'Global flavor.');
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Project flavor.' }],
  });
  const out = runnerFor(project, { home })();
  assert.match(out, /deploy — Project flavor/);
  assert.doesNotMatch(out, /Global flavor/);
});

test('the project .claude is found from the project root when cwd is a subdirectory', () => {
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  const sub = join(project, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  assert.match(runnerFor(project, { cwd: sub })(), /deploy — Deploys/);
  assert.ok(existsSync(join(project, MAP_FILE)));
});

test('a skill directory that is a junction/symlink is discovered', () => {
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  const target = join(project, 'elsewhere', 'linked');
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'SKILL.md'),
    '---\nname: linked\ndescription: Linked.\n---\n',
  );
  const skills = join(project, '.claude', 'skills');
  mkdirSync(skills, { recursive: true });
  try {
    symlinkSync(target, join(skills, 'linked'), 'junction');
  } catch {
    return; // no symlink privilege on this machine: nothing to verify here
  }
  assert.match(runnerFor(project)(), /linked — Linked/);
});

// ── The map file is written only when the catalog changed ───────────────────────────
test('an unchanged catalog does not rewrite the map file (no generatedAt churn)', () => {
  const project = makeProject({ prefix: 'capability-map-', config: ENABLED });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  const run = runnerFor(project);
  run();
  const mapPath = join(project, MAP_FILE);
  const before = readFileSync(mapPath, 'utf8');
  const stampBefore = statSync(mapPath).mtimeMs;
  run();
  run();
  assert.equal(readFileSync(mapPath, 'utf8'), before);
  assert.equal(statSync(mapPath).mtimeMs, stampBefore);
});

test('dump-defaults protocol: prints the descriptor with every param', () => {
  const out = execFileSync(process.execPath, [GATE], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_GATES_DUMP_DEFAULTS: '1' },
  });
  const descriptor = JSON.parse(out);
  assert.equal(descriptor.configKey, 'injectCapabilityMap');
  assert.equal(descriptor.enabledByDefault, true);
  assert.equal(descriptor.defaultParams.maxClauseChars, 120);
  assert.equal(descriptor.defaultParams.injectEveryMessages, 10);
  assert.ok(descriptor.defaultParams.blurbOverridesFile);
});

// ── Re-injection when the KIND of work changes ──────────────────────────────────────
const THROTTLED = {
  gates: { injectCapabilityMap: { enabled: true, injectEveryMessages: 50 } },
};

test('a prompt that pivots to a different kind of work re-injects mid-throttle', () => {
  const project = makeProject({ prefix: 'capability-map-', config: THROTTLED });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  const run = runnerFor(project);
  assert.match(run({ prompt: 'arregla el bug que rompe el login' }), /deploy/);
  assert.equal(run({ prompt: 'y ahora arregla este otro error' }), '');
  assert.match(
    run({ prompt: 'ok, ahora publica la release y taggea la version' }),
    /deploy — Deploys/,
  );
});

test('a pivot on the very next message does not re-inject what was just shown', () => {
  const project = makeProject({ prefix: 'capability-map-', config: THROTTLED });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  const run = runnerFor(project);
  assert.match(run({ prompt: 'arregla el bug que rompe el login' }), /deploy/);
  assert.equal(run({ prompt: 'publica la release y taggea la version' }), '');
});

test('staying on the same kind of work stays silent under the throttle', () => {
  const project = makeProject({ prefix: 'capability-map-', config: THROTTLED });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  const run = runnerFor(project);
  assert.match(run({ prompt: 'write the tests for the parser' }), /deploy/);
  assert.equal(run({ prompt: 'add more tests and check coverage' }), '');
  assert.equal(run({ prompt: 'one more spec please' }), '');
});

test('reinjectOnWorkNatureChange:false falls back to the throttle alone', () => {
  const project = makeProject({
    prefix: 'capability-map-',
    config: {
      gates: {
        injectCapabilityMap: {
          enabled: true,
          injectEveryMessages: 50,
          reinjectOnWorkNatureChange: false,
        },
      },
    },
  });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  const run = runnerFor(project);
  assert.match(run({ prompt: 'arregla el bug del login' }), /deploy/);
  assert.equal(run({ prompt: 'publica la release y taggea la version' }), '');
});

test('a payload with no prompt at all never counts as a pivot', () => {
  const project = makeProject({ prefix: 'capability-map-', config: THROTTLED });
  seedProject(project, {
    skills: [{ name: 'deploy', description: 'Deploys.' }],
  });
  const run = runnerFor(project);
  assert.match(run(), /deploy/);
  assert.equal(run(), '');
  assert.equal(run(), '');
});
