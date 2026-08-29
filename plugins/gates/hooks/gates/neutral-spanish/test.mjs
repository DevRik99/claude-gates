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
function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}

test('warns on Rioplatense voseo and lexicon', () => {
  assert.ok(isWarn(runGate(write('vos tenés que revisar esto, dale'))));
  assert.ok(isWarn(runGate(write('che, mirá el laburo que hicimos acá'))));
});

test('allows neutral Spanish', () => {
  assert.equal(runGate(write('tienes que revisar esto, de acuerdo')), null);
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
  assert.ok(isWarn(runGate(write('que bacano quedo esto'), { config })));
});
