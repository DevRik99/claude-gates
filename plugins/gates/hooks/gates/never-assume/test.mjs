import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, isWarn, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  return runGateProcess(GATE, payload, { config });
}

const writeSource = (content) => write('src/x.js', content);

const ENABLE = {
  config: { gates: { requireVerificationBeforeAssuming: true } },
};

test('warns on conjecture phrasing', () => {
  assert.ok(
    isWarn(runGate(writeSource('// i assume the timezone is UTC'), ENABLE)),
  );
  assert.ok(
    isWarn(runGate(writeSource('// probably fine to skip this'), ENABLE)),
  );
});

test('never denies, only warns', () => {
  const result = runGate(writeSource('// i assume this works'), ENABLE);
  assert.ok(isWarn(result));
  assert.ok(!isDeny(result));
});

test('allows content without conjecture phrasing', () => {
  assert.equal(runGate(writeSource('const x = 1;'), ENABLE), null);
});

test('disabled by default (registry default is false)', () => {
  assert.equal(runGate(writeSource('// i assume this works')), null);
});

test('warns on conjecture phrasing in Spanish', () => {
  assert.ok(
    isWarn(
      runGate(writeSource('// supongo que la zona horaria es UTC'), ENABLE),
    ),
  );
  assert.ok(
    isWarn(
      runGate(writeSource('// probablemente sea correcto omitir esto'), ENABLE),
    ),
  );
  assert.ok(
    isWarn(
      runGate(
        writeSource('// deberia ser suficiente con este chequeo'),
        ENABLE,
      ),
    ),
  );
});

test('bilingual control: ES and EN equivalent conjecture briefs both warn', () => {
  const es = writeSource(
    '// creo que el usuario ya esta autenticado, no lo verifique',
  );
  const en = writeSource(
    '// i assume the user is already authenticated, did not verify it',
  );
  assert.ok(isWarn(runGate(es, ENABLE)));
  assert.ok(isWarn(runGate(en, ENABLE)));
});

test('allows neutral Spanish content without conjecture phrasing', () => {
  assert.equal(
    runGate(writeSource('const contrasena = "verificada";'), ENABLE),
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
  assert.equal(
    runGate(writeSource('// i assume this works'), { config }),
    null,
  );
  assert.ok(
    isWarn(runGate(writeSource('// totally made up value here'), { config })),
  );
});

// ── Word boundaries: "might benefit" is not "might be" ──────────────────────────────
test('a phrase that merely starts with a conjecture phrase does not warn', () => {
  assert.equal(
    runGate(writeSource('// this might benefit from caching'), ENABLE),
    null,
  );
  assert.equal(
    runGate(writeSource('// the callers should benefit too'), ENABLE),
    null,
  );
  assert.ok(isWarn(runGate(writeSource('// it might be null'), ENABLE)));
});

test('a configured pattern is boundary-wrapped the same way as the defaults', () => {
  const config = {
    gates: {
      requireVerificationBeforeAssuming: {
        enabled: true,
        conjecturePatterns: ['guess'],
      },
    },
  };
  assert.equal(runGate(writeSource('// guessing game'), { config }), null);
  assert.ok(isWarn(runGate(writeSource('// a guess here'), { config })));
});

// ── Malformed config never escalates an advisory gate to a deny ─────────────────────
test('a malformed conjecturePatterns entry is skipped and the gate never denies', () => {
  const config = {
    gates: {
      requireVerificationBeforeAssuming: {
        enabled: true,
        conjecturePatterns: ['(unclosed', 'probably'],
      },
    },
  };
  const result = runGate(writeSource('// probably fine'), { config });
  assert.ok(isWarn(result));
  assert.ok(!isDeny(result));
  assert.equal(runGate(writeSource('const x = 1;'), { config }), null);
});
