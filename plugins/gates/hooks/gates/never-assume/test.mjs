import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  delegate,
  isDeny,
  isWarn,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

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

// ── Unverified claims: stating DONE or CORRECT, which conjecture phrasing misses ──────
test('denies a claim that something already works, with no evidence', () => {
  const result = runGate(
    writeSource('// the parser already works, just wire it up'),
    ENABLE,
  );
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /already works/);
});

test('denies the same claim in Spanish', () => {
  // Because the gates judge a user's own words, and those are not always English.
  assert.ok(isDeny(runGate(writeSource('// el parser ya funciona'), ENABLE)));
  assert.ok(isDeny(runGate(writeSource('// se ve bien'), ENABLE)));
});

test('the same claim WITH evidence goes through', () => {
  // Because naming the check is exactly the behavior being asked for.
  const withExit = runGate(
    writeSource('// already works: npm test, exit code 0'),
    ENABLE,
  );
  assert.ok(!isDeny(withExit));

  const withCount = runGate(
    writeSource('// looks good — 31/31 tests pass'),
    ENABLE,
  );
  assert.ok(!isDeny(withCount));
});

test('a claim in a delegation brief is denied too', () => {
  // Because that is the case that actually costs: the subagent inherits it as fact.
  const result = runGate(
    delegate('The store is already done. Wire the CLI to it.'),
    ENABLE,
  );
  assert.ok(isDeny(result));
});

test('ordinary description is not a claim', () => {
  // Because a false positive here blocks rather than advises.
  assert.equal(runGate(writeSource('// parses the CSV header'), ENABLE), null);
  assert.equal(
    runGate(writeSource('// this function works out the offset'), ENABLE),
    null,
  );
});

test('conjecture still only warns, never denies', () => {
  const result = runGate(writeSource('// probably fine to skip this'), ENABLE);
  assert.ok(isWarn(result));
  assert.ok(!isDeny(result));
});

test('the denial says what to do instead of just refusing', () => {
  const message = messageOf(
    runGate(writeSource('// everything works'), ENABLE),
  );
  assert.match(message, /exit code/);
  assert.match(message, /unverifiedClaimPatterns/);
});

test('the gate stays silent when the project never opted in', () => {
  assert.equal(runGate(writeSource('// already works')), null);
});
