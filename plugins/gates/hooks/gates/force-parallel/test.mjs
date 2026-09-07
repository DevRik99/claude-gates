import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  readSessionState,
  stateFileFor,
  writeSessionState,
} from '../../lib/session-state.mjs';
import {
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const GATE_ID = 'force-parallel';
const SEQUENTIAL_GAP_MS = 5000;

function delegationPayload(sessionId, prompt = 'do work') {
  return { tool_name: 'Task', session_id: sessionId, tool_input: { prompt } };
}

function session(config = { gates: { warnSequentialDelegations: true } }) {
  const project = makeProject({ config });
  const sessionId = `test-${randomUUID()}`;
  const options = { cwd: project };
  return {
    sessionId,
    run: (payload) => runGateProcess(GATE, payload, { project }),
    // Back-dates the last delegation so the next one reads as a new turn, not the same batch.
    age: () => {
      const state = readSessionState(GATE_ID, sessionId, {}, options);
      writeSessionState(
        GATE_ID,
        sessionId,
        { ...state, lastAt: Date.now() - SEQUENTIAL_GAP_MS },
        options,
      );
    },
    cleanup: () =>
      rmSync(dirname(stateFileFor(GATE_ID, sessionId, options)), {
        recursive: true,
        force: true,
      }),
  };
}

test('3 sequential delegations in the same session: the 3rd is denied', () => {
  const { sessionId, run, age, cleanup } = session();
  try {
    const first = run(delegationPayload(sessionId));
    age();
    const second = run(delegationPayload(sessionId));
    age();
    const third = run(delegationPayload(sessionId));

    assert.equal(first, null, 'first delegation should not deny');
    assert.equal(second, null, 'second delegation should not deny');
    assert.ok(isDeny(third), 'third consecutive delegation should deny');
    assert.match(messageOf(third), /warnSequentialDelegations/);
    assert.match(messageOf(third), /3rd delegation/);
  } finally {
    cleanup();
  }
});

test('a marked SEQUENTIAL-JUSTIFIED prompt never warns, even at count 3', () => {
  const { sessionId, run, age, cleanup } = session();
  try {
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    age();
    const third = run(
      delegationPayload(sessionId, 'needs prior result SEQUENTIAL-JUSTIFIED'),
    );
    assert.equal(third, null);
  } finally {
    cleanup();
  }
});

test('a non-delegation tool is never warned', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const result = run({
      tool_name: 'Bash',
      session_id: sessionId,
      tool_input: { command: 'ls' },
    });
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

// ── Regressions from the audit ─────────────────────────────────────────────────────
test('delegations launched together in one message are a batch, not sequential', () => {
  const { sessionId, run, cleanup } = session();
  try {
    assert.equal(run(delegationPayload(sessionId)), null);
    assert.equal(run(delegationPayload(sessionId)), null);
    assert.equal(run(delegationPayload(sessionId)), null);
    assert.equal(run(delegationPayload(sessionId)), null);
  } finally {
    cleanup();
  }
});

test('a batch counts once: two batches plus one lone delegation reach the threshold', () => {
  const { sessionId, run, age, cleanup } = session();
  try {
    run(delegationPayload(sessionId));
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    run(delegationPayload(sessionId));
    age();
    assert.ok(isDeny(run(delegationPayload(sessionId))));
  } finally {
    cleanup();
  }
});

test('a gap longer than sequentialWindowMs resets the count', () => {
  const { sessionId, run, age, cleanup } = session({
    gates: {
      warnSequentialDelegations: { enabled: true, sequentialWindowMs: 3000 },
    },
  });
  try {
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    age();
    assert.equal(run(delegationPayload(sessionId)), null);
  } finally {
    cleanup();
  }
});

test('a non-numeric sequentialThreshold falls back to the default of 3', () => {
  const { sessionId, run, age, cleanup } = session({
    gates: {
      warnSequentialDelegations: { enabled: true, sequentialThreshold: 'many' },
    },
  });
  try {
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    age();
    assert.ok(isDeny(run(delegationPayload(sessionId))));
  } finally {
    cleanup();
  }
});

test('a numeric sequentialJustifiedMarker falls back to the default marker', () => {
  const { sessionId, run, age, cleanup } = session({
    gates: {
      warnSequentialDelegations: {
        enabled: true,
        sequentialJustifiedMarker: 123,
      },
    },
  });
  try {
    run(delegationPayload(sessionId));
    age();
    run(delegationPayload(sessionId));
    age();
    assert.ok(isDeny(run(delegationPayload(sessionId, 'needs 123'))));
  } finally {
    cleanup();
  }
});

test('without a session id the count is keyed by project, not shared globally', () => {
  const projectA = makeProject({
    config: { gates: { warnSequentialDelegations: true } },
  });
  const projectB = makeProject({
    config: { gates: { warnSequentialDelegations: true } },
  });
  const run = (project) =>
    runGateProcess(
      GATE,
      { tool_name: 'Task', tool_input: { prompt: 'x' } },
      {
        project,
      },
    );
  const age = (project) =>
    writeSessionState(
      GATE_ID,
      null,
      { count: 2, lastAt: Date.now() - SEQUENTIAL_GAP_MS },
      { cwd: project },
    );
  try {
    age(projectA);
    assert.ok(isDeny(run(projectA)));
    assert.equal(run(projectB), null);
  } finally {
    for (const project of [projectA, projectB]) {
      rmSync(dirname(stateFileFor(GATE_ID, null, { cwd: project })), {
        recursive: true,
        force: true,
      });
    }
  }
});

// ── Segundo disparador: el principal trabajando en serie sin delegar nunca ────────────
// El primer disparador es ciego a esto: solo corre si YA hay una delegacion.
const MAIN_TRANSCRIPT = join(
  homedir(),
  '.claude',
  'projects',
  'p',
  'session-1.jsonl',
);
const SUBAGENT_TRANSCRIPT = join(
  homedir(),
  '.claude',
  'projects',
  'p',
  'session-1',
  'subagents',
  'agent-abc.jsonl',
);

function writePayload(sessionId, path, transcript = MAIN_TRANSCRIPT) {
  return {
    tool_name: 'Write',
    session_id: sessionId,
    transcript_path: transcript,
    tool_input: { file_path: path, content: 'x' },
  };
}

function editSpree(run, sessionId, count, transcript) {
  let last = null;
  for (let index = 0; index < count; index++) {
    last = run(writePayload(sessionId, `src/f${String(index)}.ts`, transcript));
  }
  return last;
}

test('el principal editando 11 ficheros distintos sin delegar es denegado', () => {
  const { sessionId, run, cleanup } = session();
  try {
    assert.equal(editSpree(run, sessionId, 10), null);
    const eleventh = run(writePayload(sessionId, 'src/f10.ts'));
    assert.ok(isDeny(eleventh));
    assert.match(messageOf(eleventh), /11 DIFFERENT files/);
    assert.match(messageOf(eleventh), /SINGLE message/);
  } finally {
    cleanup();
  }
});

// Editar diez veces el mismo fichero es iterar, y eso no se reparte entre subagentes.
test('repetir el MISMO fichero no cuenta como trabajo repartible', () => {
  const { sessionId, run, cleanup } = session();
  try {
    for (let index = 0; index < 20; index++) {
      assert.equal(run(writePayload(sessionId, 'src/uno.ts')), null);
    }
  } finally {
    cleanup();
  }
});

// Un subagente haciendo muchas ediciones es justo lo que se queria conseguir.
test('un SUBAGENTE editando muchos ficheros nunca se bloquea', () => {
  const { sessionId, run, cleanup } = session();
  try {
    const last = editSpree(run, sessionId, 25, SUBAGENT_TRANSCRIPT);
    assert.equal(last, null);
  } finally {
    cleanup();
  }
});

test('delegar reinicia la racha, de modo que la salida sea la conducta que se pide', () => {
  const { sessionId, run, cleanup } = session();
  try {
    editSpree(run, sessionId, 10);
    assert.equal(run(delegationPayload(sessionId)), null);
    assert.equal(editSpree(run, sessionId, 10), null);
  } finally {
    cleanup();
  }
});

test('un payload sin transcript_path no se trata como el principal', () => {
  const { sessionId, run, cleanup } = session();
  try {
    for (let index = 0; index < 15; index++) {
      const payload = writePayload(sessionId, `src/g${String(index)}.ts`);
      delete payload.transcript_path;
      assert.equal(run(payload), null);
    }
  } finally {
    cleanup();
  }
});

test('maxSelfEditsBeforeDelegating en 0 apaga el segundo disparador', () => {
  const { sessionId, run, cleanup } = session({
    gates: {
      warnSequentialDelegations: {
        enabled: true,
        maxSelfEditsBeforeDelegating: 0,
      },
    },
  });
  try {
    assert.equal(editSpree(run, sessionId, 30), null);
  } finally {
    cleanup();
  }
});

test('un comando de solo lectura nunca cuenta ni se deniega', () => {
  const { sessionId, run, cleanup } = session();
  try {
    for (let index = 0; index < 20; index++) {
      const result = run({
        tool_name: 'Bash',
        session_id: sessionId,
        transcript_path: MAIN_TRANSCRIPT,
        tool_input: { command: 'git status' },
      });
      assert.equal(result, null);
    }
  } finally {
    cleanup();
  }
});
