// ATTACK MATRIX — lib/attack-matrix.mjs, the judge of a test file's adversarial evidence
// boundary: COVERED — razon de 7 y de 8 caracteres, 2 y 3 mutaciones, ratio 2/5 y 3/5
// invalid-input: COVERED — un texto que no es texto y una categoria inesperada
// missing-empty: COVERED — null, undefined, sin mutaciones y lista de categorias vacia
// invalid-state: COVERED — un estado ilegible, una fila MISSING y una fila sin comentario
// dependency-failure: COVERED — un id que rompe la compilacion del patron no lanza
// idempotency-order: COVERED — filas repetidas, filas en otro orden y dos juicios seguidos
// invariant: COVERED — un fichero conforme nunca da problemas y la entrada nunca se muta
// security: COVERED — la fila nunca se corrobora a si misma y un id `.*` no evade el parser
// mutations-killed: >= -> > en el ratio, < -> <= en la razon minima, escapeForRegex borrado, hasHeader invertido, comentarios contados como evidencia
//
// justification: cada caso ataca una decision concreta del modulo. El happy path esta en un
// solo caso porque, si el juez dejara de fallar por completo, ese caso seguiria pasando y
// los demas no: son ellos los que sostienen la suite.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_REQUIRED_CATEGORIES,
  ESCAPE_HATCH,
  attackMatrixProblems,
  attackMatrixSkeleton,
  caseTitles,
  countCases,
  hasEscapeHatch,
  isTestPath,
  parseAttackMatrix,
} from '../attack-matrix.mjs';

const HEADER = 'ATTACK MATRIX — el sujeto bajo ataque';
const MUTATIONS = 'a -> b, c -> d, e -> f';

const COVERED_ROWS = DEFAULT_REQUIRED_CATEGORIES.map((id) => [
  id,
  'COVERED — el caso que lo hace',
]);

const CASE_LINES = [
  "test('el limite exacto: 9, 10 y 11', () => {});",
  "test('una entrada invalida y malformada', () => {});",
  "test('sin datos: null, undefined y vacio', () => {});",
  "test('un estado imposible y una transicion prohibida', () => {});",
  "test('la dependencia lanza y luego da timeout', () => {});",
  "test('la misma operacion dos veces y fuera de orden', () => {});",
  "test('nunca escribe cuando deniega', () => {});",
  "test('un permiso ajeno no se evade', () => {});",
];

function suite({
  header = HEADER,
  rows = COVERED_ROWS,
  mutations = MUTATIONS,
  cases = CASE_LINES,
  extra = [],
} = {}) {
  const lines = [];
  if (header !== null) lines.push(`// ${header}`);
  for (const [id, declaration] of rows) lines.push(`// ${id}: ${declaration}`);
  if (mutations !== null) lines.push(`// mutations-killed: ${mutations}`);
  return [...lines, ...extra, ...cases].join('\n');
}

function rowsWithout(id) {
  return COVERED_ROWS.filter(([rowId]) => rowId !== id);
}

function rowsWith(id, declaration) {
  return COVERED_ROWS.map((row) => (row[0] === id ? [id, declaration] : row));
}

function casesWithout(fragment) {
  return CASE_LINES.filter((line) => !line.includes(fragment));
}

function joined(problems) {
  return problems.join(' | ');
}

test('un fichero conforme nunca produce problemas', () => {
  assert.deepEqual(attackMatrixProblems(suite()), []);
});

test('sin bloque ATTACK MATRIX se rechaza con un unico problema que lo nombra', () => {
  const problems = attackMatrixProblems(suite({ header: null }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ATTACK MATRIX/);
});

test('una fila ausente se denuncia sin arrastrar a las demas', () => {
  const problems = attackMatrixProblems(
    suite({ rows: rowsWithout('boundary') }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /boundary/);
});

test('una fila declarada MISSING no pasa aunque el caso exista', () => {
  const problems = attackMatrixProblems(
    suite({ rows: rowsWith('boundary', 'MISSING') }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /MISSING/);
});

test('un estado ilegible no se acepta como cobertura', () => {
  const problems = attackMatrixProblems(
    suite({ rows: rowsWith('boundary', 'quizas mas adelante') }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /status/);
});

test('N/A con razon de 7 caracteres falla y con 8 pasa: el limite exacto', () => {
  const short = attackMatrixProblems(
    suite({ rows: rowsWith('security', 'N/A — abcdefg') }),
  );
  const exact = attackMatrixProblems(
    suite({ rows: rowsWith('security', 'N/A — abcdefgh') }),
  );
  assert.equal(short.length, 1, joined(short));
  assert.match(short[0], /reason/);
  assert.deepEqual(exact, []);
});

test('N/A escrito con dos espacios sigue siendo N/A y no se lee como estado invalido', () => {
  const problems = attackMatrixProblems(
    suite({
      rows: rowsWith('security', 'not  applicable — no hay guardia aqui'),
    }),
  );
  assert.deepEqual(problems, []);
});

test('una fila COVERED sin ningun caso que la respalde es una promesa vacia', () => {
  const problems = attackMatrixProblems(
    suite({ cases: casesWithout('permiso') }),
  );
  assert.equal(problems.length, 1, joined(problems));
  assert.match(problems[0], /security/);
});

test('la propia fila nunca se corrobora a si misma aunque cite el ataque entre comillas', () => {
  const problems = attackMatrixProblems(
    suite({
      rows: rowsWith('security', 'COVERED — el caso del "permiso" ajeno'),
      cases: casesWithout('permiso'),
    }),
  );
  assert.equal(problems.length, 1, joined(problems));
  assert.match(problems[0], /security/);
});

test('un caso comentado nunca cuenta como caso ni como evidencia', () => {
  const commented = [
    ...casesWithout('permiso'),
    "// test('un permiso ajeno no se evade', () => {});",
  ];
  const problems = attackMatrixProblems(suite({ cases: commented }));
  assert.equal(problems.length, 1, joined(problems));
  assert.match(problems[0], /security/);
});

test('2 mutaciones fallan y 3 pasan: el limite exacto de la linea', () => {
  const two = attackMatrixProblems(suite({ mutations: 'a -> b, c -> d' }));
  assert.equal(two.length, 1, joined(two));
  assert.match(two[0], /mutation/);
  assert.deepEqual(attackMatrixProblems(suite({ mutations: MUTATIONS })), []);
});

test('una mutacion de un solo caracter queda fuera por longitud minima', () => {
  const problems = attackMatrixProblems(
    suite({ mutations: 'a -> b, c -> d, x' }),
  );
  assert.equal(problems.length, 1, joined(problems));
  assert.match(problems[0], /2 mutation/);
});

test('sin linea de mutaciones el fichero falla igual que con la linea vacia', () => {
  const absent = attackMatrixProblems(suite({ mutations: null }));
  const empty = attackMatrixProblems(suite({ mutations: '   ' }));
  assert.equal(absent.length, 1, joined(absent));
  assert.deepEqual(absent, empty);
});

test('una linea vacia nunca se come la siguiente y la toma por su contenido', () => {
  const parsed = parseAttackMatrix(
    ['// mutations-killed:', "test('el limite exacto', () => {});"].join('\n'),
  );
  assert.deepEqual(parsed.mutations, []);
  const row = parseAttackMatrix(
    ['// boundary:', '// invalid-input: COVERED — x'].join('\n'),
  ).rows.get('boundary');
  assert.equal(row.reason, '');
});

test('null y undefined no lanzan: se juzgan como fichero vacio', () => {
  for (const value of [null, undefined, '']) {
    const problems = attackMatrixProblems(value);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ATTACK MATRIX/);
  }
  assert.equal(parseAttackMatrix(undefined).rows.size, 0);
  assert.equal(countCases(null), 0);
  assert.deepEqual(caseTitles(undefined), []);
});

test('un tipo equivocado (numero, objeto) se trata como texto en vez de romper', () => {
  const NUMBER = 42;
  for (const value of [NUMBER, {}, []]) {
    assert.ok(Array.isArray(attackMatrixProblems(value)));
  }
});

test('una lista de categorias vacia no exige filas pero sigue exigiendo mutaciones', () => {
  const options = { requiredCategories: [] };
  assert.deepEqual(attackMatrixProblems(suite({ rows: [] }), options), []);
  const problems = attackMatrixProblems(
    suite({ rows: [], mutations: null }),
    options,
  );
  assert.equal(problems.length, 1, joined(problems));
});

test('una categoria inesperada se acepta declarada porque no hay con que corroborarla', () => {
  const options = { requiredCategories: ['negocio-raro'] };
  const text = suite({ rows: [['negocio-raro', 'COVERED — lo que sea']] });
  assert.deepEqual(attackMatrixProblems(text, options), []);
});

test('un id con metacaracteres no evade el parser: `.*` no matchea cualquier fila', () => {
  const options = { requiredCategories: ['.*'] };
  const problems = attackMatrixProblems(suite(), options);
  assert.equal(problems.length, 1, joined(problems));
  assert.match(problems[0], /absent/);
});

test('un id con parentesis abierto rompe la compilacion y aun asi no lanza', () => {
  const options = { requiredCategories: ['a(b'] };
  assert.doesNotThrow(() => attackMatrixProblems(suite(), options));
});

test('2 de 5 titulos adversariales falla y 3 de 5 pasa: el borde del ratio', () => {
  const options = { requiredCategories: [] };
  const plain = [
    "test('funciona', () => {});",
    "test('devuelve el valor', () => {});",
    "test('lee el fichero', () => {});",
  ];
  const two = [
    "test('el limite exacto', () => {});",
    "test('una entrada invalida', () => {});",
  ];
  const three = [...two, "test('sin datos', () => {});"];
  const failing = attackMatrixProblems(
    suite({ rows: [], cases: [...plain, ...two] }),
    options,
  );
  assert.equal(failing.length, 1, joined(failing));
  assert.match(failing[0], /happy path/);
  assert.deepEqual(
    attackMatrixProblems(
      suite({ rows: [], cases: [...plain.slice(1), ...three] }),
      options,
    ),
    [],
  );
});

test('sin titulos literales el ratio no se juzga en vez de adivinarlo', () => {
  const dynamic = [
    'for (const name of NAMES) test(name, () => {});',
    'test(buildName(1), () => {});',
  ];
  assert.deepEqual(
    attackMatrixProblems(suite({ rows: [], cases: dynamic }), {
      requiredCategories: [],
    }),
    [],
  );
});

test('una fila fuera de comentario no declara nada: un literal nunca cubre una categoria', () => {
  const problems = attackMatrixProblems(
    suite({
      rows: rowsWithout('boundary'),
      extra: ['const fake = "boundary: COVERED — mentira";'],
    }),
  );
  assert.equal(problems.length, 1, joined(problems));
  assert.match(problems[0], /boundary/);
});

test('una fila repetida no cambia el veredicto: gana la primera declarada', () => {
  const rows = [['boundary', 'COVERED — el caso real'], ...COVERED_ROWS];
  assert.deepEqual(attackMatrixProblems(suite({ rows })), []);
});

test('el orden de las filas no altera el resultado', () => {
  const reversed = [...COVERED_ROWS].reverse();
  assert.deepEqual(attackMatrixProblems(suite({ rows: reversed })), []);
});

test('juzgar dos veces el mismo texto da exactamente el mismo resultado', () => {
  const text = suite({ rows: rowsWithout('invariant') });
  assert.deepEqual(attackMatrixProblems(text), attackMatrixProblems(text));
});

test('el marcador de excepcion en un literal nunca exime: solo cuenta en un comentario', () => {
  assert.equal(hasEscapeHatch(`const fixture = "${ESCAPE_HATCH}";`), false);
  assert.equal(hasEscapeHatch(`// ${ESCAPE_HATCH} — fixture generado`), true);
  assert.equal(hasEscapeHatch(`// ${ESCAPE_HATCH}`, ''), false);
  assert.equal(hasEscapeHatch(null), false);
});

test('el borde del patron de rutas: test.mjs es un test y testing.mjs no', () => {
  assert.equal(isTestPath('src/thing.test.mjs'), true);
  assert.equal(isTestPath('gates/x/test.mjs'), true);
  assert.equal(isTestPath('lib/testing.mjs'), false);
  assert.equal(isTestPath(''), false);
  assert.equal(isTestPath('src/thing.test.mjs', '([a-z'), true);
});

test('el esqueleto que se ofrece al denegar contiene todas las filas exigidas', () => {
  const skeleton = attackMatrixSkeleton(DEFAULT_REQUIRED_CATEGORIES);
  for (const id of DEFAULT_REQUIRED_CATEGORIES) {
    assert.ok(skeleton.includes(id), `falta la fila ${id}`);
  }
  assert.match(skeleton, /mutations-killed/);
});
