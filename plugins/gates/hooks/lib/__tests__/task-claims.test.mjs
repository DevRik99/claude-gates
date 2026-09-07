// comment-ok: encabezado de fichero, explica el montaje del test (home falso) y no el codigo.
// La regla de reservas probada directamente: cuando una tarea reclamada por otro agente deja
// de bloquearte. El disparador real es si la sesion duena SIGUE viva, no un reloj fijo, asi
// que cada caso monta un transcript falso y le pone la antiguedad que corresponde.
//
// os.homedir() lee USERPROFILE (Windows) o HOME (POSIX) en cada llamada, asi que apuntarlos a
// un temporal mantiene el home real fuera de los tests.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  blocksCaller,
  claimIsLive,
  DEFAULT_IDLE_MS,
  idleWindowMs,
  ownerSessionState,
} from '../task-claims.mjs';

const OWNER = 'agent-otro';
const ME = 'agent-yo';
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60 * 1000;

function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), 'claims-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function projectRoot(claimIdleMinutes) {
  const root = mkdtempSync(join(tmpdir(), 'claims-root-'));
  mkdirSync(join(root, '.ai'), { recursive: true });
  const config = claimIdleMinutes === undefined ? {} : { claimIdleMinutes };
  writeFileSync(join(root, '.ai', 'config.json'), JSON.stringify(config));
  return root;
}

function plantTranscript(home, root, owner, ageMinutes) {
  const slug = String(root).replace(/[:\\/]/g, '-');
  const directory = join(home, '.claude', 'projects', slug);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${owner}.jsonl`);
  writeFileSync(file, '{}\n');
  const when = new Date(Date.now() - ageMinutes * MS_PER_MINUTE);
  utimesSync(file, when, when);
}

function claimedTask(minutesAgo = 1) {
  return {
    id: 't1',
    owner: OWNER,
    claimedAt: new Date(Date.now() - minutesAgo * MS_PER_MINUTE).toISOString(),
  };
}

test('la ventana por defecto es una hora', () => {
  assert.equal(DEFAULT_IDLE_MS, MINUTES_PER_HOUR * MS_PER_MINUTE);
  assert.equal(idleWindowMs(projectRoot()), DEFAULT_IDLE_MS);
});

test('claimIdleMinutes en .ai/config.json manda sobre el default', () => {
  assert.equal(idleWindowMs(projectRoot(5)), 5 * MS_PER_MINUTE);
});

test('un claimIdleMinutes invalido cae al default en vez de dejar todo libre', () => {
  // Porque un cero o un texto apagarian las reservas en silencio.
  assert.equal(idleWindowMs(projectRoot(0)), DEFAULT_IDLE_MS);
  assert.equal(idleWindowMs(projectRoot('mucho')), DEFAULT_IDLE_MS);
});

test('una sesion que escribio hace poco esta activa', () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 5);

  assert.equal(ownerSessionState(OWNER, root), 'active');
});

test('una sesion callada mas que la ventana cuenta como ida', () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 90);

  assert.equal(ownerSessionState(OWNER, root), 'gone');
});

test('sin transcript el estado es desconocido, no muerto', () => {
  // Porque la ruta podria no derivarse igual en otra plataforma, y robar una reserva por eso
  // seria peor que esperar.
  scratchHome();
  assert.equal(ownerSessionState(OWNER, projectRoot()), 'unknown');
});

test('la reserva de una sesion ida se libera YA, aunque acabe de reclamarla', () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 90);

  assert.equal(claimIsLive(claimedTask(1), Date.now(), root), false);
  assert.equal(blocksCaller(claimedTask(1), ME, Date.now(), root), true);
});

test('la reserva de una sesion viva aguanta, aunque sea vieja', () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 2);

  const old = claimedTask(MINUTES_PER_HOUR * 12);
  assert.equal(claimIsLive(old, Date.now(), root), true);
  assert.equal(blocksCaller(old, ME, Date.now(), root), false);
});

test('tu propia reserva nunca te bloquea a ti', () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 2);

  assert.equal(blocksCaller(claimedTask(1), OWNER, Date.now(), root), true);
});

test('sin transcript se cae a la antiguedad de la reserva', () => {
  scratchHome();
  const root = projectRoot(30);

  assert.equal(claimIsLive(claimedTask(5), Date.now(), root), true);
  assert.equal(claimIsLive(claimedTask(45), Date.now(), root), false);
});

test('una tarea sin dueno esta libre y bloquea a quien actua', () => {
  assert.equal(claimIsLive({ id: 't1' }, Date.now(), projectRoot()), false);
  assert.equal(blocksCaller({ id: 't1' }, ME, Date.now(), projectRoot()), true);
});
