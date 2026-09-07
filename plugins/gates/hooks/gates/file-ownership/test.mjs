// Cada caso va con su contrario (bloquea la del otro / deja pasar la mía), porque un gate que
// dejara de disparar por completo pasaría la mitad de esta suite sin que nadie lo notara.
// Los tres invariantes que cumple cada gate se re-comprueban aquí: este toca la escritura.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  edit,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ME = 'agent-yo';
const OTHER = 'agent-otro';
const STALE_HOURS = 9;
const MS_PER_HOUR = 60 * 60 * 1000;

function claimed(owns, owner, claimedAt = new Date().toISOString()) {
  return {
    id: 't-1',
    title: 'the other agent work',
    status: 'open',
    owner,
    claimedAt,
    owns,
  };
}

function project({ tasks = [], enabled = true } = {}) {
  return makeProject({
    prefix: 'file-ownership-',
    config: { gates: { blockWritesToClaimedFiles: { enabled } } },
    files: { '.ai/tasks/active.json': JSON.stringify({ tasks }) },
  });
}

function run(payload, options = {}) {
  return runGateProcess(
    GATE,
    { ...payload, session_id: options.sessionId ?? ME },
    { project: project(options) },
  );
}

test('un write a un fichero reclamado por OTRO agente se deniega', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.ok(isDeny(result));
});

test('un write a MI propio fichero reclamado pasa', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], ME)],
  });
  assert.equal(result, null);
});

test('un fichero que nadie reclamo se edita libremente', () => {
  const result = run(write('src/otro.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.equal(result, null);
});

test('una tarea de otro SIN owns no bloquea nada', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [{ id: 't-1', title: 'sin owns', status: 'open', owner: OTHER }],
  });
  assert.equal(result, null);
});

test('una reserva caducada libera el fichero', () => {
  // Porque un agente que muere sin liberar retendria sus ficheros para siempre.
  const stale = new Date(Date.now() - STALE_HOURS * MS_PER_HOUR).toISOString();
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER, stale)],
  });
  assert.equal(result, null);
});

test('reclamar un directorio cubre lo que cuelga de el', () => {
  const result = run(write('src/lib/deep/util.ts', 'x'), {
    tasks: [claimed(['src/lib'], OTHER)],
  });
  assert.ok(isDeny(result));
});

test('un directorio reclamado no cubre a un hermano con prefijo parecido', () => {
  const result = run(write('src/libro.ts', 'x'), {
    tasks: [claimed(['src/lib'], OTHER)],
  });
  assert.equal(result, null);
});

test('un Edit se juzga igual que un Write', () => {
  const result = run(edit('src/auth.ts', 'nuevo'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.ok(isDeny(result));
});

test('una redireccion de shell a un fichero reclamado tambien se deniega', () => {
  const result = run(bash('echo hola > src/auth.ts'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.ok(isDeny(result));
});

test('la denegacion nombra el fichero, la tarea, el dueno y la salida', () => {
  const message = messageOf(
    run(write('src/auth.ts', 'x'), {
      tasks: [claimed(['src/auth.ts'], OTHER)],
    }),
  );
  assert.match(message, /src\/auth\.ts/);
  assert.match(message, /t-1/);
  assert.match(message, new RegExp(OTHER));
  assert.match(message, /--free/);
  assert.match(message, /task claim t-1/);
});

test('una tarea cerrada ya no reserva sus ficheros', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [{ ...claimed(['src/auth.ts'], OTHER), status: 'done' }],
  });
  assert.equal(result, null);
});

test('un comando de solo lectura nunca se deniega', () => {
  const result = run(bash('cat src/auth.ts'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.equal(result, null);
});

test('el remedio del propio toolkit nunca se deniega', () => {
  const result = run(bash('claude-gates task list --free'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.equal(result, null);
});

test('el gate apagado no dice nada', () => {
  const result = run(write('src/auth.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
    enabled: false,
  });
  assert.equal(result, null);
});

test('un write fuera del proyecto no se compara contra owns', () => {
  // Porque `owns` solo puede nombrar rutas de dentro del proyecto.
  const result = run(write('../fuera.ts', 'x'), {
    tasks: [claimed(['src/auth.ts'], OTHER)],
  });
  assert.equal(result, null);
});
