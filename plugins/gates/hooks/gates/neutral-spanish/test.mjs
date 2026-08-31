import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'neutral-spanish-'));
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

function write(content) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: '/repo/notes.md', content },
  };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('DENIES Rioplatense voseo and lexicon (now a hard block, not a warn)', () => {
  assert.ok(isDeny(runGate(write('vos tenés que revisar esto, dale'))));
  assert.ok(isDeny(runGate(write('che, mirá el laburo que hicimos acá'))));
});

test('allows neutral Spanish', () => {
  assert.equal(runGate(write('tienes que revisar esto, de acuerdo')), null);
});

test('escape hatch: the marker in content allows legitimate regional text through', () => {
  // A literal quote / fixture / log the author intentionally keeps regional.
  assert.equal(
    runGate(
      write('El testigo dijo: "che, no sé nada". neutral-spanish:allow'),
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(write('vos tenés que revisar esto'), {
      config: { gates: { warnNonNeutralSpanish: false } },
    }),
    null,
  );
});

test('project regionalMarkers override replaces the built-in list', () => {
  const config = {
    gates: {
      warnNonNeutralSpanish: { enabled: true, regionalMarkers: ['bacano'] },
    },
  };
  assert.equal(runGate(write('vos tenés que revisar esto'), { config }), null);
  assert.ok(isDeny(runGate(write('que bacano quedo esto'), { config })));
});
