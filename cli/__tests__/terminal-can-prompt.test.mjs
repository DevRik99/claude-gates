// ATTACK MATRIX — terminalCanPrompt: whether init may draw a picker at all
// boundary: N/A — the predicate compares no magnitudes, only three capabilities being present
// invalid-input: COVERED — a number, a string and a bare object standing in for a stream
// missing-empty: COVERED — null, undefined and the call with no arguments at all
// invalid-state: COVERED — isTTY present with setRawMode absent, the state that froze the VPS
// dependency-failure: N/A — it calls nothing: it reads three properties off what it was given
// idempotency-order: COVERED — twice over the same pair decides the same and mutates neither
// invariant: COVERED — never promises a prompt while any of the three capabilities is missing
// security: N/A — it decides no permission and touches no path, credential or process
// mutations-killed: && -> ||, setRawMode check removed, stdout.isTTY dropped, Boolean inverted
//
// justification: the happy path is here once, because a function that returned true always
// would still pass it. The cases that hold this suite up are the ones demanding false.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalCanPrompt } from '../init.mjs';

const realTerminal = () => ({ isTTY: true, setRawMode() {} });

test('el unico caso que promete un prompt: las tres capacidades presentes', () => {
  assert.equal(terminalCanPrompt(realTerminal(), { isTTY: true }), true);
});

test('sin ningun stream nunca se promete un prompt: null, undefined y sin argumentos', () => {
  assert.equal(terminalCanPrompt(null, null), false);
  assert.equal(terminalCanPrompt(undefined, undefined), false);
  assert.equal(terminalCanPrompt(null, { isTTY: true }), false);
  assert.equal(terminalCanPrompt(realTerminal(), null), false);
});

test('isTTY sin setRawMode: el estado que deja la VPS congelada tras el banner', () => {
  assert.equal(terminalCanPrompt({ isTTY: true }, { isTTY: true }), false);
  assert.equal(
    terminalCanPrompt({ isTTY: true, setRawMode: true }, { isTTY: true }),
    false,
  );
  assert.equal(
    terminalCanPrompt({ isTTY: true, setRawMode: null }, { isTTY: true }),
    false,
  );
});

test('nunca basta un solo extremo: cada capacidad que falta apaga el prompt', () => {
  const combinations = [
    [{ isTTY: false, setRawMode() {} }, { isTTY: true }],
    [{ isTTY: true, setRawMode() {} }, { isTTY: false }],
    [{ isTTY: false, setRawMode() {} }, { isTTY: false }],
    [{ setRawMode() {} }, { isTTY: true }],
    [realTerminal(), {}],
  ];
  for (const [stdin, stdout] of combinations) {
    assert.equal(
      terminalCanPrompt(stdin, stdout),
      false,
      JSON.stringify({ stdin: Object.keys(stdin), stdout }),
    );
  }
});

test('una entrada invalida no lanza: un numero, un string o un objeto vacio dan false', () => {
  for (const value of [0, 1, '', 'tty', {}, [], Number.NaN]) {
    assert.equal(terminalCanPrompt(value, value), false, String(value));
  }
});

test('un isTTY que miente con un valor no booleano nunca se lee como terminal', () => {
  assert.equal(
    terminalCanPrompt({ isTTY: '', setRawMode() {} }, { isTTY: true }),
    false,
  );
  assert.equal(
    terminalCanPrompt({ isTTY: 0, setRawMode() {} }, { isTTY: true }),
    false,
  );
  assert.equal(
    terminalCanPrompt({ isTTY: 'si', setRawMode() {} }, { isTTY: 'si' }),
    true,
  );
});

test('llamarla dos veces decide lo mismo y nunca muta los streams', () => {
  const stdin = realTerminal();
  const stdout = { isTTY: true };
  const before = [Object.keys(stdin).sort(), Object.keys(stdout).sort()];

  assert.equal(terminalCanPrompt(stdin, stdout), true);
  assert.equal(terminalCanPrompt(stdin, stdout), true);
  assert.deepEqual(
    [Object.keys(stdin).sort(), Object.keys(stdout).sort()],
    before,
  );
});

test('el resultado es siempre un booleano, nunca el valor bruto de isTTY', () => {
  assert.strictEqual(terminalCanPrompt({ isTTY: 1 }, { isTTY: 1 }), false);
  assert.strictEqual(
    terminalCanPrompt({ isTTY: 1, setRawMode() {} }, { isTTY: 1 }),
    true,
  );
});
