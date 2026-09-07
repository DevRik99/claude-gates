// ATTACK MATRIX — findProjectRoot: the climb that hung `claude-gates init` on a VPS
// boundary: COVERED — the marker directly at cwd, one level up, and none anywhere above
// invalid-input: COVERED — a path that does not exist and a home that is not a real path
// missing-empty: COVERED — an empty home, and a cwd with no marker in the whole chain
// invalid-state: COVERED — a home that is not an ancestor of cwd, the impossible state
//   that spun forever
// dependency-failure: COVERED — find-up refusing to come back is asserted as a failure in a
//   child process, so a synchronous spin reports instead of freezing the run
// idempotency-order: COVERED — twice from the same directory answers the same
// invariant: COVERED — it always returns, and never returns home or anything above it
// security: N/A — it reads directory names, grants nothing and writes nowhere
// mutations-killed: stopAt reintroduced, the home guard removed, ?? startDirectory dropped
//
// justification: the case that matters is not "it finds the root" but "it comes back at
// all". Every assertion here runs out-of-process because an infinite `while (true)` blocks
// the event loop, so an in-process timeout would hang the suite instead of reporting it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CONFIG_MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'config.mjs',
);
const CHILD_TIMEOUT_MS = 10000;

function pathToUrl(path) {
  return new URL(`file://${path.replace(/\\/g, '/')}`).href;
}

/**
 * Answers in a child process so a synchronous spin surfaces as a killed process rather
 * than a frozen test run. `null` means it never came back inside the timeout.
 */
function rootFrom(startDirectory, home) {
  const script =
    `import { findProjectRoot } from ${JSON.stringify(pathToUrl(CONFIG_MODULE))};` +
    `process.stdout.write(findProjectRoot(${JSON.stringify(startDirectory)},` +
    ` { home: ${JSON.stringify(home)} }));`;
  try {
    return execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
    );
  } catch {
    return null;
  }
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'find-root-'));
}

function withMarker(directory, marker = '.git') {
  mkdirSync(join(directory, marker), { recursive: true });
  return directory;
}

/**
 * What a chain with no marker of its own can promise. The scratch directory lives under a
 * real filesystem whose ancestors may carry a `.git` or `.ai` of their own, so pinning an
 * exact path here would assert the machine, not the function: it must come back, and the
 * answer must be the directory it started from or something above it.
 */
function assertAncestorOrSelf(result, startDirectory) {
  assert.notEqual(result, null, 'no volvio dentro del timeout');
  assert.ok(
    startDirectory === result || startDirectory.startsWith(result + sep),
    `${result} no es ${startDirectory} ni un ancestro suyo`,
  );
}

test('un home que no esta por encima del cwd: el estado que colgaba la VPS', () => {
  const base = scratch();
  const project = withMarker(join(base, 'code', 'app'));
  const home = join(base, 'ubuntu');
  mkdirSync(home, { recursive: true });

  assert.equal(rootFrom(project, home), project);
});

test('si find-up no responde dentro del timeout el caso falla en vez de congelar la suite', () => {
  const { root } = parse(scratch());

  assert.notEqual(rootFrom(root, join(root, 'home-que-no-esta-arriba')), null);
});

test('sin ningun marcador en toda la cadena la subida termina y no baja del cwd', () => {
  const base = scratch();
  const deep = join(base, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });

  assertAncestorOrSelf(rootFrom(deep, join(base, 'otro-home')), deep);
});

test('nunca devuelve el home ni nada por encima aunque el marcador este ahi', () => {
  const home = withMarker(scratch());
  const project = join(home, 'proyecto', 'sin', 'marcador');
  mkdirSync(project, { recursive: true });

  assert.equal(rootFrom(project, home), project);
});

test('el cwd es el propio home: vuelve el home sin subir ni un nivel', () => {
  const home = scratch();

  assert.equal(rootFrom(home, home), home);
});

test('el borde de la subida: marcador en el cwd, un nivel arriba, o en ninguno', () => {
  const base = scratch();
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });

  const exact = withMarker(join(base, 'exacto'));
  assert.equal(rootFrom(exact, home), exact);

  const parent = withMarker(join(base, 'padre'));
  const child = join(parent, 'hijo');
  mkdirSync(child, { recursive: true });
  assert.equal(rootFrom(child, home), parent);

  const orphan = join(base, 'huerfano');
  mkdirSync(orphan, { recursive: true });
  assertAncestorOrSelf(rootFrom(orphan, home), orphan);
});

test('el marcador mas cercano gana: un .git anidado no cede al de arriba', () => {
  const base = scratch();
  const outer = withMarker(join(base, 'fuera'));
  const inner = withMarker(join(outer, 'dentro'));

  assert.equal(rootFrom(inner, join(base, 'home')), inner);
});

test('.git como fichero (worktree) cuenta igual que el directorio', () => {
  const base = scratch();
  const project = join(base, 'worktree');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, '.git'), 'gitdir: /otro/sitio\n');
  const child = join(project, 'src');
  mkdirSync(child, { recursive: true });

  assert.equal(rootFrom(child, join(base, 'home')), project);
});

test('una entrada invalida no cuelga: cwd inexistente y home vacio vuelven igual', () => {
  const base = scratch();
  const missing = join(base, 'no', 'existe', 'esto');

  assertAncestorOrSelf(rootFrom(missing, ''), missing);
  assertAncestorOrSelf(rootFrom(missing, join(base, 'home')), missing);
});

test('dos llamadas desde el mismo sitio responden lo mismo', () => {
  const base = scratch();
  const project = withMarker(join(base, 'repetido'));
  const home = join(base, 'home');

  assert.equal(rootFrom(project, home), rootFrom(project, home));
});
