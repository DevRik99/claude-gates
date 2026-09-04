import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  return runGateProcess(GATE, payload, { config });
}

const writeNotes = (content) => write('notes.md', content);

test('DENIES Rioplatense voseo and lexicon (a hard block, not a warn)', () => {
  assert.ok(isDeny(runGate(writeNotes('vos tenés que revisar esto, dale'))));
  assert.ok(isDeny(runGate(writeNotes('che, mirá el laburo que hicimos acá'))));
});

test('allows neutral Spanish', () => {
  assert.equal(
    runGate(writeNotes('tienes que revisar esto, de acuerdo')),
    null,
  );
});

test('escape hatch: the marker in content allows legitimate regional text through', () => {
  assert.equal(
    runGate(
      writeNotes('El testigo dijo: "che, no sé nada". neutral-spanish:allow'),
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(writeNotes('vos tenés que revisar esto'), {
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
  assert.equal(
    runGate(writeNotes('vos tenés que revisar esto'), { config }),
    null,
  );
  assert.ok(isDeny(runGate(writeNotes('que bacano quedo esto'), { config })));
});

// ── Only Spanish prose is scanned ───────────────────────────────────────────────────
test('"Author: Dale Carnegie" in a code file is not a marker hit', () => {
  assert.equal(
    runGate(write('src/quotes.ts', '// Author: Dale Carnegie\nexport {};')),
    null,
  );
});

test('"send an SOS signal" in a code file is not a marker hit', () => {
  assert.equal(
    runGate(write('src/radio.js', 'function alert() { send an SOS signal }')),
    null,
  );
});

test('Spanish prose inside a code file (enough function words) is still scanned', () => {
  assert.ok(
    isDeny(
      runGate(
        write(
          'src/x.js',
          '// che, mirá que la función de los usuarios no anda para nada',
        ),
      ),
    ),
  );
});

test('a text-type file is scanned even when short (no function-word threshold)', () => {
  assert.ok(isDeny(runGate(write('README.md', 'dale, mirá esto'))));
  assert.ok(isDeny(runGate(write('config.yml', 'mensaje: dale'))));
});

test('project textExtensions override replaces the built-in list', () => {
  const config = {
    gates: {
      warnNonNeutralSpanish: { enabled: true, textExtensions: ['.po'] },
    },
  };
  assert.equal(runGate(write('notes.md', 'dale'), { config }), null);
  assert.ok(isDeny(runGate(write('es.po', 'msgstr "dale"'), { config })));
});

// ── Robustness ──────────────────────────────────────────────────────────────────────
test('a non-string marker in the configured list is skipped instead of throwing', () => {
  const config = {
    gates: {
      warnNonNeutralSpanish: {
        enabled: true,
        regionalMarkers: [42, null, 'bacano'],
      },
    },
  };
  assert.equal(runGate(writeNotes('todo bien'), { config }), null);
  assert.ok(isDeny(runGate(writeNotes('que bacano'), { config })));
});

test('a configured escapeHatch replaces the default marker', () => {
  const config = {
    gates: {
      warnNonNeutralSpanish: { enabled: true, escapeHatch: 'ok-regional' },
    },
  };
  assert.equal(runGate(writeNotes('dale, ok-regional'), { config }), null);
  assert.ok(
    isDeny(runGate(writeNotes('dale, neutral-spanish:allow'), { config })),
  );
});
