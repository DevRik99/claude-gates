// ATTACK MATRIX — `claude-gates tests`: el barrido que comprueba ficheros ya escritos
// boundary: COVERED — testing.mjs justo fuera del patron y test.mjs justo dentro
// invalid-input: COVERED — una ruta inexistente y una que no es de test
// missing-empty: COVERED — un arbol sin tests y un fichero de test vacio
// invalid-state: COVERED — un fichero de test sin una sola linea de evidencia
// dependency-failure: N/A — el unico fallo de lectura alcanzable es una ruta que no existe, y esa cae en la fila missing-empty; el catch de lectura queda como defensa sin camino observable
// idempotency-order: COVERED — barrer la misma ruta dos veces no duplica el resultado
// invariant: COVERED — node_modules nunca se recorre y nada fuera de las rutas pedidas aparece
// security: COVERED — el marcador en un literal no exime; en un comentario si
// mutations-killed: SKIPPED_DIRECTORIES vaciado, el Set `seen` borrado, exempt invertido, isTestPath ignorado en walk
//
// justification: el caso feliz (un fichero conforme no da problemas) esta una vez. Lo que
// sostiene la suite son los que exigen que el barrido NO recorra lo que no debe y que un
// fichero sin evidencia no pase.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ESCAPE_HATCH } from '../../plugins/gates/hooks/lib/attack-matrix.mjs';
import { checkTestFiles, renderTestsCheck } from '../tests-check.mjs';

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

const HAPPY_ONLY = "test('devuelve el valor', () => {});";

const COMPLIANT = [
  '// ATTACK MATRIX — el sujeto bajo ataque',
  ...ROWS.map((id) => `// ${id}: COVERED — el caso real`),
  '// mutations-killed: a -> b, c -> d, e -> f',
  ...CASES,
].join('\n');

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'tests-check-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

function check(files, targets = []) {
  return checkTestFiles(targets, { cwd: project(files) });
}

test('un fichero conforme no produce problemas', () => {
  const results = check({ 'src/thing.test.mjs': COMPLIANT });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].problems, []);
});

test('un fichero de solo happy path se reporta con su problema', () => {
  const results = check({ 'src/thing.test.mjs': HAPPY_ONLY });
  assert.equal(results.length, 1);
  assert.match(results[0].problems[0], /ATTACK MATRIX/);
  assert.match(renderTestsCheck(results), /FAIL/);
});

test('un fichero de test vacio se reporta en vez de pasar por no tener nada', () => {
  const results = check({ 'src/thing.test.mjs': '' });
  assert.equal(results.length, 1);
  assert.equal(results[0].problems.length, 1);
});

test('un arbol sin ficheros de test devuelve cero resultados', () => {
  const results = check({ 'src/thing.mjs': HAPPY_ONLY, 'README.md': 'hola' });
  assert.deepEqual(results, []);
});

test('una ruta inexistente no rompe el barrido: devuelve nada', () => {
  const results = check({ 'src/thing.test.mjs': COMPLIANT }, ['no/existe']);
  assert.deepEqual(results, []);
});

test('el borde del patron: testing.mjs no se recorre y test.mjs si', () => {
  const results = check({
    'lib/testing.mjs': HAPPY_ONLY,
    'gates/x/test.mjs': HAPPY_ONLY,
  });
  assert.deepEqual(
    results.map((result) => result.file.replaceAll('\\', '/')),
    ['gates/x/test.mjs'],
  );
});

test('node_modules nunca se recorre, aunque tenga tests dentro', () => {
  const results = check({
    'node_modules/pkg/thing.test.mjs': HAPPY_ONLY,
    'src/thing.test.mjs': COMPLIANT,
  });
  assert.equal(results.length, 1);
  assert.match(results[0].file.replaceAll('\\', '/'), /^src\//);
});

test('el marcador en un comentario exime; el mismo texto en un literal nunca', () => {
  const exempt = check({
    'src/thing.test.mjs': `// ${ESCAPE_HATCH} — fixture generado\n${HAPPY_ONLY}`,
  });
  assert.equal(exempt[0].exempt, true);
  assert.deepEqual(exempt[0].problems, []);

  const quoted = check({
    'src/thing.test.mjs': `const marker = "${ESCAPE_HATCH}";\n${HAPPY_ONLY}`,
  });
  assert.equal(quoted[0].exempt, false);
  assert.equal(quoted[0].problems.length, 1);
});

test('barrer la misma ruta dos veces no duplica el resultado', () => {
  const results = checkTestFiles(['src', 'src/thing.test.mjs'], {
    cwd: project({ 'src/thing.test.mjs': COMPLIANT }),
  });
  assert.equal(results.length, 1);
});

test('nada fuera de las rutas pedidas aparece en el resultado', () => {
  const results = checkTestFiles(['src'], {
    cwd: project({
      'src/thing.test.mjs': COMPLIANT,
      'otro/aparte.test.mjs': HAPPY_ONLY,
    }),
  });
  assert.equal(results.length, 1);
  assert.match(results[0].file.replaceAll('\\', '/'), /^src\//);
});

test('el resumen cuenta los fallos y los exentos por separado', () => {
  const results = check({
    'a/one.test.mjs': HAPPY_ONLY,
    'a/two.test.mjs': `// ${ESCAPE_HATCH} — fixture\n${HAPPY_ONLY}`,
    'a/three.test.mjs': COMPLIANT,
  });
  const rendered = renderTestsCheck(results);
  assert.match(rendered, /3 test file\(s\) checked/);
  assert.match(rendered, /1 without adversarial evidence/);
  assert.match(rendered, /1 exempt/);
});
