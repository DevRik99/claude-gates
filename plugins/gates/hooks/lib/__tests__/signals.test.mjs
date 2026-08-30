import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RISK_SIGNAL,
  MONEY_SIGNAL,
  AUTH_SIGNAL,
  DESTRUCTIVE_DEPLOY_SIGNAL,
  CONJECTURE,
  PERSISTENCE_VERB,
  withUnicodeWordBoundary,
} from '../signals.mjs';

// ── RISK_SIGNAL ──────────────────────────────────────────────────────────────────────

test('RISK_SIGNAL matches money terms in EN and ES', () => {
  assert.ok(RISK_SIGNAL.test('update the payment flow'));
  assert.ok(RISK_SIGNAL.test('actualizar el flujo de pago'));
  assert.ok(RISK_SIGNAL.test('mover el saldo de una cuenta'));
  assert.ok(RISK_SIGNAL.test('move the account balance'));
});

test('RISK_SIGNAL matches auth terms in EN and ES', () => {
  assert.ok(RISK_SIGNAL.test('reset the user password'));
  assert.ok(RISK_SIGNAL.test('resetear la contrasena del usuario'));
  assert.ok(RISK_SIGNAL.test('resetear la contraseña del usuario'));
  assert.ok(RISK_SIGNAL.test('cambiar la sesion activa'));
  assert.ok(RISK_SIGNAL.test('cambiar la sesión activa'));
});

test('RISK_SIGNAL matches destructive/deploy terms in EN and ES', () => {
  assert.ok(RISK_SIGNAL.test('deploy to production'));
  assert.ok(RISK_SIGNAL.test('desplegar a produccion'));
  assert.ok(RISK_SIGNAL.test('truncate the orders table'));
  assert.ok(RISK_SIGNAL.test('eliminar la tabla de pedidos'));
  assert.ok(RISK_SIGNAL.test('run the migration'));
  assert.ok(RISK_SIGNAL.test('correr la migracion'));
});

test('bilingual control: an ES risk brief matches exactly like its EN equivalent', () => {
  const es = 'implementa el endpoint para mover el saldo de una cuenta bancaria';
  const en = 'implement the endpoint to move the balance of a bank account';
  assert.equal(RISK_SIGNAL.test(es), RISK_SIGNAL.test(en));
  assert.ok(RISK_SIGNAL.test(es));
});

test('RISK_SIGNAL does not fire on neutral text', () => {
  assert.equal(RISK_SIGNAL.test('add a tooltip to the button'), false);
  assert.equal(RISK_SIGNAL.test('agregar un tooltip al boton'), false);
});

test('RISK_SIGNAL false-positive guard: short terms require a full word', () => {
  // "auth" inside "autor", "prod" inside "producto", "token" inside "tokenizer".
  assert.equal(RISK_SIGNAL.test('the autor of this book'), false);
  assert.equal(RISK_SIGNAL.test('el autor de este libro'), false);
  assert.equal(RISK_SIGNAL.test('compra este producto'), false);
  assert.equal(RISK_SIGNAL.test('buy this product'), false);
  assert.equal(RISK_SIGNAL.test('the tokenizer splits words'), false);
});

test('MONEY_SIGNAL / AUTH_SIGNAL / DESTRUCTIVE_DEPLOY_SIGNAL are independently usable', () => {
  assert.ok(MONEY_SIGNAL.test('pago'));
  assert.equal(MONEY_SIGNAL.test('auth'), false);
  assert.ok(AUTH_SIGNAL.test('token'));
  assert.equal(AUTH_SIGNAL.test('pago'), false);
  assert.ok(DESTRUCTIVE_DEPLOY_SIGNAL.test('produccion'));
  assert.equal(DESTRUCTIVE_DEPLOY_SIGNAL.test('pago'), false);
});

// ── CONJECTURE ───────────────────────────────────────────────────────────────────────

test('CONJECTURE matches EN and ES conjecture phrasing', () => {
  assert.ok(CONJECTURE.test('i assume the timezone is UTC'));
  assert.ok(CONJECTURE.test('probably fine to skip this'));
  assert.ok(CONJECTURE.test('supongo que esto funciona'));
  assert.ok(CONJECTURE.test('asumo que el usuario ya esta logueado'));
  assert.ok(CONJECTURE.test('deberia ser suficiente con esto'));
  assert.ok(CONJECTURE.test('debería ser suficiente con esto'));
  assert.ok(CONJECTURE.test('creo que esto anda bien'));
});

test('bilingual control: ES and EN conjecture brief both trigger', () => {
  const es = 'creo que el usuario ya esta autenticado, no lo verifique';
  const en = 'i assume the user is already authenticated, did not verify it';
  assert.equal(CONJECTURE.test(es), CONJECTURE.test(en));
  assert.ok(CONJECTURE.test(es));
});

test('CONJECTURE does not fire on neutral confirmed statements', () => {
  assert.equal(CONJECTURE.test('verified: the timezone is UTC per config.json'), false);
  assert.equal(CONJECTURE.test('confirmado: el usuario esta autenticado'), false);
});

// ── PERSISTENCE_VERB ─────────────────────────────────────────────────────────────────

test('PERSISTENCE_VERB matches EN and ES persistence instructions', () => {
  assert.ok(PERSISTENCE_VERB.test('save this to state.json'));
  assert.ok(PERSISTENCE_VERB.test('guarda esto en decision.md'));
  assert.ok(PERSISTENCE_VERB.test('persist the result in the database'));
  assert.ok(PERSISTENCE_VERB.test('escribi esto en el archivo'));
  assert.ok(PERSISTENCE_VERB.test('anota el resultado en el log'));
});

test('PERSISTENCE_VERB does not fire on unrelated prose', () => {
  assert.equal(PERSISTENCE_VERB.test('the button looks nice'), false);
  assert.equal(PERSISTENCE_VERB.test('el boton se ve bien'), false);
});

// ── withUnicodeWordBoundary ──────────────────────────────────────────────────────────

test('withUnicodeWordBoundary rejects a substring match', () => {
  const pattern = withUnicodeWordBoundary('auth');
  assert.ok(pattern.test('auth required'));
  assert.equal(pattern.test('autor'), false);
});
