// ATTACK MATRIX — el gate adversarial-tests: que deniega, que deja pasar y por donde se evade
// boundary: COVERED — minMutations en 2 y en 3, y un fragmento con 0 y con 1 caso
// invalid-input: COVERED — testPathPattern con un regex roto y un parametro mal tipado
// missing-empty: COVERED — contenido vacio, sin ruta y un fichero que no existe en disco
// invalid-state: COVERED — un edit que borra las filas y un fragmento sobre fichero ausente
// dependency-failure: COVERED — el fichero de disco ilegible no hace pasar el fragmento
// idempotency-order: COVERED — el mismo payload dos veces decide lo mismo
// invariant: COVERED — nunca deniega solo-lectura, ni su remedio, ni un fichero que no es test
// security: COVERED — un heredoc y una herramienta MCP de escritura no evaden el gate
// mutations-killed: countCases === 0 invertido, evidenceWeight > -> >=, exencion de solo-lectura borrada, escape hatch ignorado, grupo write quitado del runGate
//
// justification: el caso feliz (un test conforme pasa) esta una sola vez. Si el gate dejara
// de disparar entero, ese caso seguiria en verde: los que sostienen la suite son los que
// exigen una denegacion concreta y los que prueban que NO dispara donde no debe.

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
const CONFIG_KEY = 'requireAdversarialTests';
const TEST_FILE = 'src/thing.test.mjs';

const ROWS = [
  'boundary',
  'invalid-input',
  'missing-empty',
  'invalid-state',
  'dependency-failure',
  'idempotency-order',
  'invariant',
  'security',
];

const CASES = [
  "test('el limite exacto: 9, 10 y 11', () => {});",
  "test('una entrada invalida y malformada', () => {});",
  "test('sin datos: null, undefined y vacio', () => {});",
  "test('un estado imposible y una transicion prohibida', () => {});",
  "test('la dependencia lanza y luego da timeout', () => {});",
  "test('la misma operacion dos veces y fuera de orden', () => {});",
  "test('nunca escribe cuando deniega', () => {});",
  "test('un permiso ajeno no se evade', () => {});",
];

const HAPPY_ONLY = [
  "test('devuelve el valor', () => {});",
  "test('lee el fichero', () => {});",
];

function compliant({
  mutations = 'a -> b, c -> d, e -> f',
  cases = CASES,
} = {}) {
  return [
    '// ATTACK MATRIX — el sujeto bajo ataque',
    ...ROWS.map((id) => `// ${id}: COVERED — el caso real`),
    `// mutations-killed: ${mutations}`,
    ...cases,
  ].join('\n');
}

function run(payload, { enabled = true, parameters = {}, files } = {}) {
  const project = makeProject({
    prefix: 'adversarial-tests-',
    config: { gates: { [CONFIG_KEY]: { enabled, ...parameters } } },
    files,
  });
  return runGateProcess(GATE, payload, { project });
}

test('un test conforme pasa: la evidencia declarada y corroborada basta', () => {
  assert.equal(run(write(TEST_FILE, compliant())), null);
});

test('un test de solo happy path se deniega y el mensaje trae el esqueleto', () => {
  const result = run(write(TEST_FILE, HAPPY_ONLY.join('\n')));
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /ATTACK MATRIX/);
  assert.match(messageOf(result), /mutations-killed/);
});

test('el gate nunca toca un fichero que no es de test', () => {
  assert.equal(run(write('src/thing.mjs', HAPPY_ONLY.join('\n'))), null);
  assert.equal(run(write('src/testing.mjs', HAPPY_ONLY.join('\n'))), null);
});

test('un .spec.ts y un test.mjs suelto tambien se juzgan', () => {
  for (const path of ['src/thing.spec.ts', 'gates/x/test.mjs']) {
    assert.ok(isDeny(run(write(path, HAPPY_ONLY.join('\n')))), path);
  }
});

test('con el gate apagado nunca deniega nada', () => {
  const result = run(write(TEST_FILE, HAPPY_ONLY.join('\n')), {
    enabled: false,
  });
  assert.equal(result, null);
});

test('contenido vacio y ruta ausente no producen decision', () => {
  assert.equal(run(write(TEST_FILE, '   ')), null);
  assert.equal(run(write('', HAPPY_ONLY.join('\n'))), null);
});

test('el escape hatch declarado en el fichero lo exime', () => {
  const content = `// adversarial-tests:allow — fixture generado\n${HAPPY_ONLY.join('\n')}`;
  assert.equal(run(write(TEST_FILE, content)), null);
});

test('un edit sin casos nuevos es mantenimiento y nunca se deniega', () => {
  const result = run(
    edit(TEST_FILE, 'assert.equal(x, 2);', 'assert.equal(x, 1);'),
    { files: { [TEST_FILE]: HAPPY_ONLY.join('\n') } },
  );
  assert.equal(result, null);
});

test('un edit que agrega un caso a un fichero sin evidencia se deniega', () => {
  const result = run(edit(TEST_FILE, "test('otro mas', () => {});"), {
    files: { [TEST_FILE]: HAPPY_ONLY.join('\n') },
  });
  assert.ok(isDeny(result));
});

test('un edit que agrega un caso a un fichero con evidencia pasa', () => {
  const result = run(
    edit(TEST_FILE, "test('un limite mas: 0 y 1', () => {});"),
    { files: { [TEST_FILE]: compliant() } },
  );
  assert.equal(result, null);
});

test('un edit que borra filas de la matriz se deniega aunque no agregue casos', () => {
  const removal = run(
    edit(
      TEST_FILE,
      '// boundary: COVERED — el caso real',
      [
        '// boundary: COVERED — el caso real',
        '// security: COVERED — el caso real',
      ].join('\n'),
    ),
    { files: { [TEST_FILE]: compliant() } },
  );
  assert.ok(isDeny(removal));
  assert.match(messageOf(removal), /deletes attack-matrix rows/);
});

test('si el fichero de disco no existe el fragmento se juzga solo, sin dejarlo pasar', () => {
  const result = run(edit(TEST_FILE, "test('otro mas', () => {});"));
  assert.ok(isDeny(result));
});

test('el escape hatch que ya vive en disco exime al fragmento', () => {
  const onDisk = `// adversarial-tests:allow — fixture\n${HAPPY_ONLY.join('\n')}`;
  const result = run(edit(TEST_FILE, "test('otro mas', () => {});"), {
    files: { [TEST_FILE]: onDisk },
  });
  assert.equal(result, null);
});

test('un heredoc que escribe un test no evade el gate', () => {
  const command = `cat > ${TEST_FILE} <<'EOF'\n${HAPPY_ONLY.join('\n')}\nEOF`;
  assert.ok(isDeny(run(bash(command))));
});

test('copiar o mover un test no es escribirlo: nunca se deniega', () => {
  assert.equal(run(bash(`cp ${TEST_FILE} backup/thing.test.mjs`)), null);
});

test('el gate nunca deniega un comando de solo lectura', () => {
  for (const command of [
    'cat src/thing.test.mjs',
    'git status',
    'node --test',
  ]) {
    assert.equal(run(bash(command)), null, command);
  }
});

test('el gate nunca deniega el remedio del propio toolkit', () => {
  const command =
    'claude-gates task add "sub" --parent p --size small --verify-command "echo ok"';
  assert.equal(run(bash(command)), null);
});

test('una herramienta MCP de escritura no es un punto ciego', () => {
  const payload = {
    tool_name: 'mcp__files__write_file',
    tool_input: { path: TEST_FILE, content: HAPPY_ONLY.join('\n') },
  };
  assert.ok(isDeny(run(payload)));
});

test('una delegacion no es una escritura: el gate no opina', () => {
  const payload = {
    tool_name: 'Agent',
    tool_input: { prompt: `escribe ${TEST_FILE} con dos tests` },
  };
  assert.equal(run(payload), null);
});

test('minMutations en 2 acepta lo que en 3 rechaza: el limite es el parametro', () => {
  const content = compliant({ mutations: 'a -> b, c -> d' });
  assert.ok(isDeny(run(write(TEST_FILE, content))));
  assert.equal(
    run(write(TEST_FILE, content), { parameters: { minMutations: 2 } }),
    null,
  );
});

test('requiredCategories reducido deja de exigir las filas que quito', () => {
  const content = [
    '// ATTACK MATRIX — solo dos filas',
    '// boundary: COVERED — el limite exacto',
    '// invariant: COVERED — nunca escribe cuando deniega',
    '// mutations-killed: a -> b, c -> d, e -> f',
    ...CASES.slice(0, 1),
    "test('nunca escribe cuando deniega', () => {});",
  ].join('\n');
  assert.ok(isDeny(run(write(TEST_FILE, content))));
  assert.equal(
    run(write(TEST_FILE, content), {
      parameters: { requiredCategories: ['boundary', 'invariant'] },
    }),
    null,
  );
});

test('un testPathPattern con regex invalido cae al patron por defecto en vez de romper', () => {
  const result = run(write(TEST_FILE, HAPPY_ONLY.join('\n')), {
    parameters: { testPathPattern: '([a-z' },
  });
  assert.ok(isDeny(result));
});

test('un parametro mal tipado se ignora y el gate sigue juzgando con sus defaults', () => {
  const result = run(write(TEST_FILE, HAPPY_ONLY.join('\n')), {
    parameters: { minMutations: 'tres', requiredCategories: 'todas' },
  });
  assert.ok(isDeny(result) || messageOf(result).includes('config param'));
});

test('el mismo payload dos veces decide exactamente lo mismo', () => {
  const payload = write(TEST_FILE, HAPPY_ONLY.join('\n'));
  assert.deepEqual(run(payload), run(payload));
});
