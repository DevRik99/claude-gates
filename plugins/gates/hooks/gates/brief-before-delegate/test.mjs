import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'brief-before-delegate-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
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

function delegate(prompt, extra = {}) {
  return { tool_name: 'Agent', tool_input: { prompt, ...extra } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}
const ENABLED = { config: { gates: { requireBriefBeforeDelegating: true } } };

test('denies an implementation delegation with no goal/steps/criterion', () => {
  const result = runGate(
    delegate('Fix the login bug please, thanks.'),
    ENABLED,
  );
  assert.ok(isDeny(result));
});

test('allows a complete brief with goal, steps and done-when criterion', () => {
  const prompt = [
    'Objetivo: fix the broken login redirect so users land on the dashboard.',
    '',
    'Haceres:',
    '- update src/auth/redirect.js to use the post-login route',
    '- add a regression test for the redirect',
    '',
    'Criterio: se considera hecho cuando el test de regresion pasa y el login redirige correctamente.',
  ].join('\n');
  assert.equal(runGate(delegate(prompt), ENABLED), null);
});

test('allows a read-only exploration prompt without a brief', () => {
  assert.equal(
    runGate(
      delegate('Investiga donde esta definida la funcion de login.'),
      ENABLED,
    ),
    null,
  );
});

test('allows a read-only subagent even with an implementation verb', () => {
  assert.equal(
    runGate(
      delegate('Implementa un resumen de como arreglar el login.', {
        subagent_type: 'explore',
      }),
      ENABLED,
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(delegate('Fix the login bug please, thanks.'), {
      config: { gates: { requireBriefBeforeDelegating: false } },
    }),
    null,
  );
});

test('off by default when config is silent', () => {
  assert.equal(runGate(delegate('Fix the login bug please, thanks.')), null);
});

test('project minBriefLength override changes the length threshold', () => {
  const config = {
    gates: {
      requireBriefBeforeDelegating: { enabled: true, minBriefLength: 20 },
    },
  };
  const prompt =
    'Fix the login bug in the auth module now, using the same approach as before.';
  // With the default 180-char minimum, this short prompt is denied outright for length.
  assert.ok(isDeny(runGate(delegate(prompt), ENABLED)));
  // With the length floor lowered to 20, it clears the length check. It still misses
  // all three signals, which is its own hard-deny path — but the reason changes: this
  // proves the override changed the length check specifically, by using a prompt that
  // is long enough that only two signals are missing (a goal is present), which is a
  // warn rather than a deny.
  const withGoal = `Goal: ${prompt}`;
  const result = runGate(delegate(withGoal), { config });
  assert.ok(!isDeny(result));
});
