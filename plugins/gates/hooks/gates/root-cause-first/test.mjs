import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  delegate,
  isDeny,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  return runGateProcess(GATE, payload, { config });
}

const ENABLE = { config: { gates: { requireRootCauseBeforePatch: true } } };
const writeSource = (content) => write('src/x.js', content);

test('denies a patch-marker comment in a write', () => {
  assert.ok(isDeny(runGate(writeSource('// TODO fix later patch'), ENABLE)));
});

test('denies the same marker inside a delegation prompt', () => {
  assert.ok(
    isDeny(runGate(delegate('add a // TODO fix later patch comment'), ENABLE)),
  );
});

test('allows innocuous content', () => {
  assert.equal(runGate(writeSource('const x = 1;'), ENABLE), null);
});

test('disabled by default (registry default is false)', () => {
  assert.equal(runGate(writeSource('// TODO fix later patch')), null);
});

test('project patchMarkerPatterns override replaces the built-in list', () => {
  const config = {
    gates: {
      requireRootCauseBeforePatch: {
        enabled: true,
        patchMarkerPatterns: ['hack-me-later'],
      },
    },
  };
  assert.equal(
    runGate(writeSource('// TODO fix later patch'), { config }),
    null,
  );
  assert.ok(isDeny(runGate(writeSource('// hack-me-later'), { config })));
});

// ── Malformed config never turns into "deny everything" ─────────────────────────────
test('a malformed patchMarkerPatterns entry is skipped, the valid ones still apply', () => {
  const config = {
    gates: {
      requireRootCauseBeforePatch: {
        enabled: true,
        patchMarkerPatterns: ['[unclosed', 'hack-me-later'],
      },
    },
  };
  assert.equal(runGate(writeSource('const x = 1;'), { config }), null);
  assert.ok(isDeny(runGate(writeSource('// hack-me-later'), { config })));
});

test('a non-array patchMarkerPatterns falls back to the defaults instead of throwing', () => {
  const config = {
    gates: {
      requireRootCauseBeforePatch: {
        enabled: true,
        patchMarkerPatterns: 'hotfix',
      },
    },
  };
  // The lib surfaces the ignored param once as a warn; what matters is no deny and the
  // defaults still applying.
  assert.ok(!isDeny(runGate(writeSource('const x = 1;'), { config })));
  assert.ok(isDeny(runGate(writeSource('// quick fix for now'), { config })));
});

test('an empty patchMarkerPatterns list matches nothing', () => {
  const config = {
    gates: {
      requireRootCauseBeforePatch: { enabled: true, patchMarkerPatterns: [] },
    },
  };
  assert.equal(runGate(writeSource('// hotfix'), { config }), null);
});

// ── The broadened defaults the registry promises ────────────────────────────────────
test('the built-in markers cover hotfix, quick fix, workaround, temporary fix and Spanish forms', () => {
  for (const marker of [
    '// hotfix: retry',
    '// quick fix',
    '// workaround for the race',
    '// temporary fix',
    '// parche temporal',
    '// arreglo rápido',
    '// apaño',
    '// FIXME: patch this',
  ]) {
    assert.ok(isDeny(runGate(writeSource(marker), ENABLE)), marker);
  }
});

test('the deny message quotes the matched marker and the exact remedy line', () => {
  const result = runGate(writeSource('// workaround'), ENABLE);
  assert.match(messageOf(result), /"workaround"/);
  assert.match(messageOf(result), /root cause:/);
});

// ── A diagnosis in the same content clears the marker ───────────────────────────────
test('a marker accompanied by a diagnosis line in the same content is allowed', () => {
  assert.equal(
    runGate(
      writeSource(
        '// root cause: the pool is exhausted under load\n// workaround until the pool is resized',
      ),
      ENABLE,
    ),
    null,
  );
  assert.equal(
    runGate(
      delegate(
        'Diagnóstico: el cache no invalida. Aplicá un parche temporal mientras tanto.',
      ),
      ENABLE,
    ),
    null,
  );
});

// ── Tests and docs are not patches ──────────────────────────────────────────────────
test('writing a test file that names the marker is allowed', () => {
  assert.equal(
    runGate(write('gates/root-cause-first/test.mjs', "test('hotfix')"), ENABLE),
    null,
  );
  assert.equal(
    runGate(write('src/thing.spec.ts', '// TODO fix later patch'), ENABLE),
    null,
  );
});

test('writing a markdown/text document that mentions the marker is allowed', () => {
  assert.equal(
    runGate(write('docs/process.md', 'Never ship a hotfix.'), ENABLE),
    null,
  );
  assert.equal(runGate(write('NOTES.txt', 'quick fix'), ENABLE), null);
});
