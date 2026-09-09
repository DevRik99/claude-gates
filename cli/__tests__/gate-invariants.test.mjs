// Invariants that hold for EVERY gate, checked in one place instead of trusted to each
// author's memory. This is the root fix for a defect this repo actually shipped:
// recurrence-lock exempts read-only commands and its own remedy; require-task-split — same
// repo, same author — shipped without either and produced a hard deadlock. It denied
// `grep`, it denied `task list`, and it denied `claude-gates task add --parent`, the exact
// command its own message ordered. Every sanctioned way out was closed and the operator had
// to reach in from outside the harness to break the loop. Three times in one session.
//
// Per-gate fixes cannot prevent the 51st gate from being born with the same hole, so the
// rules live here:
//
//   1. NO GATE MAY DENY A READ-ONLY COMMAND. Looking at why you are blocked cannot make
//      the situation worse. A gate that denies `git status` has taken away diagnosis.
//   2. NO GATE MAY DENY THIS TOOLKIT'S OWN REMEDY. Registering, splitting, parking or
//      closing a task, and toggling a gate, are how an operator SATISFIES a gate. A gate
//      that denies them is not a guard, it is a trap.
//   3. EVERY DENIAL MUST BE ACTIONABLE. "No" is not a useful answer: the message has to
//      name what to do next, or the operator is left guessing which of 50 gates wants what.
//
// The scratch project is seeded into the WORST case on purpose — an unsplit large task and
// an open recurrence at threshold — because a gate that never fires would pass rules 1 and
// 2 vacuously. The point is to catch the gates that DO fire broadly.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRegistry, allGates } from '../registry.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_RUN_TIMEOUT_MS = 10000;

// Surfaces an operator uses to diagnose or to escape. A gate guarding something else (a
// Stop hook, an ask tool) cannot deadlock these.
const GUARDED_GROUPS = new Set(['execution', 'shell', 'write', 'delegation']);

function seedWorstCaseProject(registry) {
  const project = mkdtempSync(join(tmpdir(), 'gate-invariants-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai', 'tasks'), { recursive: true });

  const gates = {};
  for (const gate of allGates(registry))
    gates[gate.configKey] = { enabled: true };
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({ adopted: true, gates }),
  );
  writeFileSync(
    join(project, '.ai', 'tasks', 'active.json'),
    JSON.stringify({
      tasks: [
        {
          id: 'unsplit-1',
          title: 'a large task nobody split',
          status: 'open',
          size: 'large',
        },
      ],
    }),
  );
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({
      classes: [
        {
          class: 'a defect class left open',
          occurrences: [{ id: 'one' }, { id: 'two' }],
          status: 'open',
        },
      ],
    }),
  );
  return project;
}

function denialFrom(gate, payload, project) {
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [join(REPO, 'plugins', gate.plugin, 'hooks', gate.script)],
      {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd: project,
        env: {
          ...process.env,
          HOME: project,
          USERPROFILE: project,
          CLAUDE_GATES_LOG: '0',
        },
        timeout: GATE_RUN_TIMEOUT_MS,
      },
    );
  } catch {
    return null; // A gate that cannot run at all is smoke.mjs's problem, not this test's.
  }
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const output = parsed?.hookSpecificOutput ?? {};
  return output.permissionDecision === 'deny'
    ? (output.permissionDecisionReason ?? '')
    : null;
}

const guardedGates = allGates(loadRegistry()).filter(
  (gate) =>
    gate.event === 'PreToolUse' &&
    gate.tools.some((tool) => GUARDED_GROUPS.has(tool)),
);

function bash(command) {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 'gate-invariants',
  };
}

const READ_ONLY_COMMANDS = [
  'git status',
  'git log --oneline -5',
  'cat package.json',
  'node --test',
];

const SELF_REMEDY_COMMANDS = [
  'claude-gates task add "sub" --parent p --size small --verify-command "echo ok"',
  'claude-gates task block abc --reason "waiting"',
  'node cli/index.mjs task list',
  'claude-gates disable some-gate --project',
];

function offendersFor(commands, project) {
  const offenders = [];
  for (const gate of guardedGates) {
    for (const command of commands) {
      const reason = denialFrom(gate, bash(command), project);
      if (reason)
        offenders.push(
          `${gate.id} denied \`${command}\`: ${reason.slice(0, 90)}`,
        );
    }
  }
  return offenders;
}

test('no gate denies a read-only command, even in the worst case', () => {
  const offenders = offendersFor(
    READ_ONLY_COMMANDS,
    seedWorstCaseProject(loadRegistry()),
  );
  assert.deepEqual(
    offenders,
    [],
    "A gate that denies read-only commands takes away the operator's ability to diagnose " +
      `why they are blocked:\n  ${offenders.join('\n  ')}`,
  );
});

test("no gate denies this toolkit's own remedy", () => {
  const offenders = offendersFor(
    SELF_REMEDY_COMMANDS,
    seedWorstCaseProject(loadRegistry()),
  );
  assert.deepEqual(
    offenders,
    [],
    'These commands are how an operator SATISFIES a gate. Denying them closes the only ' +
      `sanctioned way out:\n  ${offenders.join('\n  ')}`,
  );
});

// Because a denial that only refuses leaves the operator with nowhere to go, every message
// must point at a next step. The vocabulary is the one the good messages here already use —
// protected-paths says "ask the user, or edit protectedPaths"; reuse-before-build gives the
// exact phrase to add.
const ACTIONABLE =
  /\b(add|set|use|run|edit|write|declare|ask|remove|replace|pick|state|split|close|fix|retry|instead)\b/i;

test('every denial names what to do next, not just what was refused', () => {
  const project = seedWorstCaseProject(loadRegistry());
  const mute = [];
  for (const gate of guardedGates) {
    const reason =
      denialFrom(gate, bash('rm -rf / --no-preserve-root'), project) ??
      denialFrom(gate, bash('git push --force origin main'), project);
    if (reason && !ACTIONABLE.test(reason))
      mute.push(`${gate.id}: ${reason.slice(0, 100)}`);
  }
  assert.deepEqual(
    mute,
    [],
    'A denial that does not say what to do next leaves the operator guessing which of ' +
      `${guardedGates.length} gates wants what:\n  ${mute.join('\n  ')}`,
  );
});

// because the bracketed prefix is documented as the exact key to look up under "gates" in
// .ai/config.json, a label that is not a configKey sends the reader to search a file that
// never contained it. Three hooks shipped that way ([wiring-check], [tasks], [capabilities]),
// so the rule is checked rather than remembered.
// so that a regex character class (`[a-z]`) and a computed property (`[existingKey]`) are
// not mistaken for a user-facing label, this anchors to a quote and a following space.
const LABEL_PATTERN = /['"`]\[([A-Za-z][\w-]*)\] /g;
const HOOK_SOURCES = ['plugins/gates/hooks', 'plugins/tasks/hooks'];

function sourceFilesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sourceFilesUnder(full));
    } else if (entry.name.endsWith('.mjs') && !entry.name.includes('test')) {
      files.push(full);
    }
  }
  return files;
}

test('every bracketed label in a hook message is a real config key', () => {
  const configKeys = new Set(
    allGates(loadRegistry()).map((gate) => gate.configKey),
  );
  const strays = [];
  for (const directory of HOOK_SOURCES) {
    for (const file of sourceFilesUnder(join(REPO, directory))) {
      const source = readFileSync(file, 'utf8');
      for (const [, label] of source.matchAll(LABEL_PATTERN)) {
        if (configKeys.has(label)) continue;
        if (!/^[a-z]+([A-Z][a-z]+)+$/.test(label) && !label.includes('-'))
          continue;
        strays.push(`${file.replace(REPO, '.')}: [${label}]`);
      }
    }
  }
  assert.deepEqual(
    strays,
    [],
    'A label that is not a config key sends the reader to search .ai/config.json for ' +
      `something that is not there:\n  ${strays.join('\n  ')}`,
  );
});
