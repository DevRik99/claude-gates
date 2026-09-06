import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decisionOf,
  delegate,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'index.mjs');
const TRACK = join(HERE, 'track.mjs');

const ENABLED = { gates: { requireSkillCheckBeforeActing: true } };

const DATAVIZ =
  'Use this skill whenever you are about to create any chart, graph, plot, dashboard ' +
  'or data visualization, including legend, axis and tooltip decisions.';

function seedSkill(root, name, description) {
  const directory = join(root, '.claude', 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

/** A scratch project with skills on disk and an isolated HOME, so the real ~/.claude
 * never leaks its several hundred skills into an assertion. */
function projectWithSkills(skills, { config = ENABLED } = {}) {
  const project = makeProject({ prefix: 'skill-first-', config });
  for (const [name, description] of Object.entries(skills))
    seedSkill(project, name, description);
  return project;
}

function run(payload, project) {
  return runGateProcess(GATE, payload, { project });
}

const CHART_WRITE = write(
  'src/report.js',
  'export function render() {\n' +
    '  // draw the chart with a legend, axis ticks and a tooltip for the dashboard\n' +
    '  return plotVisualization(dashboardData);\n' +
    '}\n',
);

test('denies a write an available skill plausibly covers', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const result = run(CHART_WRITE, project);
  assert.equal(decisionOf(result), 'deny');
  assert.match(messageOf(result), /dataviz/);
  assert.match(messageOf(result), /requireSkillCheckBeforeActing/);
});

test('off by default: the same action passes with no config declared', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ }, { config: null });
  assert.equal(run(CHART_WRITE, project), null);
});

test('silent when no skill is relevant to the action', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const unrelated = write(
    'src/auth.js',
    'export function hashPassword(secret) {\n  return bcrypt.hashSync(secret, 10);\n}\n',
  );
  assert.equal(run(unrelated, project), null);
});

test('silent when the project has no skills at all', () => {
  const project = makeProject({ prefix: 'skill-first-', config: ENABLED });
  assert.equal(run(CHART_WRITE, project), null);
});

test('an audit sentence in the content clears the check', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const cleared = write(
    'src/report.js',
    '// no skill covers this\n' +
      'export function render() {\n' +
      '  // draw the chart with a legend, axis ticks and a tooltip for the dashboard\n' +
      '  return plotVisualization(dashboardData);\n' +
      '}\n',
  );
  assert.equal(run(cleared, project), null);
});

test('naming the skill being followed clears the check', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const cleared = write(
    'src/report.js',
    '// using the dataviz skill\n' +
      'export function render() {\n' +
      '  // draw the chart with a legend, axis ticks and a tooltip for the dashboard\n' +
      '  return plotVisualization(dashboardData);\n' +
      '}\n',
  );
  assert.equal(run(cleared, project), null);
});

test('a delegation whose prompt a skill covers is denied, and its prompt audit clears it', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const prompt =
    'Build the dashboard: draw a chart with a legend, an axis and a tooltip for the ' +
    'visualization of the weekly data.';
  assert.equal(decisionOf(run(delegate(prompt), project)), 'deny');
  assert.equal(run(delegate(`${prompt} No skill covers this.`), project), null);
});

test('a shell command that names a skill is judged like any other action', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const command = {
    tool_name: 'Bash',
    tool_input: {
      command:
        'node scripts/plot.js --chart bar --legend right --axis time --tooltip on --dashboard weekly',
    },
  };
  assert.equal(decisionOf(run(command, project)), 'deny');
});

test('a short action carries too little text to judge and is never blocked', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  assert.equal(
    run({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, project),
    null,
  );
});

test('minTokenOverlap raises the bar: the same action stops matching', () => {
  const project = projectWithSkills(
    { dataviz: DATAVIZ },
    {
      config: {
        gates: {
          requireSkillCheckBeforeActing: { enabled: true, minTokenOverlap: 50 },
        },
      },
    },
  );
  assert.equal(run(CHART_WRITE, project), null);
});

// ── The tracker: an actually-loaded skill clears the check ──────────────────────────
function trackSkillInvocation(project, sessionId, skill) {
  execFileSync(process.execPath, [TRACK], {
    input: JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill },
      session_id: sessionId,
    }),
    encoding: 'utf8',
    cwd: project,
    env: {
      ...process.env,
      HOME: project,
      USERPROFILE: project,
      CLAUDE_GATES_LOG: '0',
    },
  });
}

test('loading the relevant skill in this session clears the check', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const sessionId = `skill-first-track-${process.pid}`;
  const payload = { ...CHART_WRITE, session_id: sessionId };
  assert.equal(decisionOf(run(payload, project)), 'deny');
  trackSkillInvocation(project, sessionId, 'dataviz');
  assert.equal(run(payload, project), null);
});

test('loading an UNRELATED skill does not clear the check', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const sessionId = `skill-first-unrelated-${process.pid}`;
  const payload = { ...CHART_WRITE, session_id: sessionId };
  trackSkillInvocation(project, sessionId, 'some-other-skill');
  assert.equal(decisionOf(run(payload, project)), 'deny');
});

test('a plugin-qualified skill name is recorded under its bare name too', () => {
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const sessionId = `skill-first-plugin-${process.pid}`;
  const payload = { ...CHART_WRITE, session_id: sessionId };
  trackSkillInvocation(project, sessionId, 'someplugin:dataviz');
  assert.equal(run(payload, project), null);
});

// ── Shadowing and roots, through the shared lib ─────────────────────────────────────
test('a project skill shadows a global one of the same name', () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-first-home-'));
  seedSkill(home, 'dataviz', 'Global flavor about totally unrelated matters.');
  const project = projectWithSkills({ dataviz: DATAVIZ });
  const result = runGateProcess(GATE, CHART_WRITE, {
    project,
    environment: { HOME: home, USERPROFILE: home },
  });
  assert.equal(decisionOf(result), 'deny');
});

test('dump-defaults protocol: prints the descriptor with every param', () => {
  const out = execFileSync(process.execPath, [GATE], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_GATES_DUMP_DEFAULTS: '1' },
  });
  const descriptor = JSON.parse(out);
  assert.equal(descriptor.configKey, 'requireSkillCheckBeforeActing');
  assert.equal(descriptor.enabledByDefault, false);
  assert.equal(descriptor.defaultParams.minTokenOverlap, 3);
  assert.deepEqual(descriptor.defaultParams.kinds, ['skills']);
});
