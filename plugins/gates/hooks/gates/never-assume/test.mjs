import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'never-assume-'));
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
    tool_input: { file_path: '/repo/src/x.js', content },
  };
}
function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

const ENABLE = {
  config: { gates: { requireVerificationBeforeAssuming: true } },
};

test('warns on conjecture phrasing', () => {
  assert.ok(isWarn(runGate(write('// i assume the timezone is UTC'), ENABLE)));
  assert.ok(isWarn(runGate(write('// probably fine to skip this'), ENABLE)));
});

test('never denies, only warns', () => {
  const result = runGate(write('// i assume this works'), ENABLE);
  assert.ok(isWarn(result));
  assert.ok(!isDeny(result));
});

test('allows content without conjecture phrasing', () => {
  assert.equal(runGate(write('const x = 1;'), ENABLE), null);
});

test('disabled by default (registry default is false)', () => {
  assert.equal(runGate(write('// i assume this works')), null);
});

test('warns on conjecture phrasing in Spanish', () => {
  assert.ok(
    isWarn(runGate(write('// supongo que la zona horaria es UTC'), ENABLE)),
  );
  assert.ok(
    isWarn(runGate(write('// probablemente sea correcto omitir esto'), ENABLE)),
  );
  assert.ok(
    isWarn(
      runGate(write('// deberia ser suficiente con este chequeo'), ENABLE),
    ),
  );
});

test('bilingual control: ES and EN equivalent conjecture briefs both warn', () => {
  const es = write(
    '// creo que el usuario ya esta autenticado, no lo verifique',
  );
  const en = write(
    '// i assume the user is already authenticated, did not verify it',
  );
  assert.ok(isWarn(runGate(es, ENABLE)));
  assert.ok(isWarn(runGate(en, ENABLE)));
});

test('allows neutral Spanish content without conjecture phrasing', () => {
  assert.equal(
    runGate(write('const contrasena = "verificada";'), ENABLE),
    null,
  );
});

test('project conjecturePatterns override replaces the built-in list', () => {
  const config = {
    gates: {
      requireVerificationBeforeAssuming: {
        enabled: true,
        conjecturePatterns: ['totally made up'],
      },
    },
  };
  assert.equal(runGate(write('// i assume this works'), { config }), null);
  assert.ok(
    isWarn(runGate(write('// totally made up value here'), { config })),
  );
});
