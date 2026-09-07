// attack-matrix.mjs — parses and judges the ADVERSARIAL evidence a test file carries.
//
// justification: no existing helper covers this. `gates/test-matrix` asks a DELEGATION
// PROMPT to name which test TYPES apply (unit/E2E/visual) before the work starts; this
// reads the test FILE that came out the other end and answers a different question — did
// those tests try to break the implementation, and can anyone check that they did.
// `lib/signals.mjs` carries prose signals but has no notion of a test case.
//
// Why this exists at all: "write tests" is satisfied by four assertions on the happy path,
// and a suite like that passes forever without ever having been able to fail. The doctrine
// (ignore the happy path, attack boundaries, invert conditions, kill mutants) is only
// enforceable if the file states which attacks it made AND that statement can be
// corroborated against the cases actually present. So a compliant file carries two halves:
//
//   1. A DECLARATION — one comment row per category, each COVERED / N/A + reason / MISSING,
//      plus the mutations the suite would kill.
//   2. CORROBORATION — for every row declared COVERED, at least one case in the file that
//      names that attack. A row nothing backs up is a claim, not evidence, so it is treated
//      as a failure: the declaration alone is a checkbox anyone can tick without working.
//
// Known limitation: corroboration is LEXICAL. A case that attacks a boundary while calling
// itself "case 3" is not recognized, and a case named after a boundary that asserts nothing
// is. It cannot read assertions. What it buys is that no claimed row is free — each costs a
// named case — and that an auditor has one fixed place to look. The ratio check is skipped
// when a suite has no literal titles (table-driven), instead of guessing at them.

import { withUnicodeWordBoundary } from './signals.mjs';

/**
 * One row of the doctrine's matrix. `signals` are the words a case name uses when it really
 * attacks that dimension, in Spanish and English because briefs and tests here are written
 * in both; `why` is quoted back in the skeleton so a row never has to be looked up.
 */
export const ATTACK_CATEGORIES = Object.freeze([
  {
    id: 'boundary',
    signals:
      'boundary|bound|limit|l[ií]mite|umbral|threshold|off[- ]by[- ]one|edge|borde|' +
      'exact|exact[ao]|min|minimum|m[ií]nimo|max|maximum|m[aá]ximo|justo|zero|cero|' +
      'overflow|desborde|length|longitud',
    why: 'both sides of every comparison: limit-1, limit, limit+1',
  },
  {
    id: 'invalid-input',
    signals:
      'invalid|inv[aá]lid[ao]s?|malformed|malformad[ao]s?|garbage|basura|corrupt|' +
      'corrupt[ao]s?|bogus|unexpected|inesperad[ao]s?|wrong type|tipo equivocado|' +
      'nonsense|no es v[aá]lid[ao]|junk',
    why: 'the worst reasonable value a caller could pass',
  },
  {
    id: 'missing-empty',
    signals:
      'missing|falta|faltante|empty|vac[ií][ao]s?|null|undefined|absent|ausente|sin|' +
      'blank|nothing|nada|no data|omitid[ao]s?|omit',
    why: 'absent, empty, null and undefined inputs',
  },
  {
    id: 'invalid-state',
    signals:
      'state|estado|transition|transici[oó]n|out of order|fuera de orden|stale|' +
      'caducad[ao]s?|expired|expirad[ao]s?|terminal|impossible|imposible|conflict|' +
      'conflicto|conflictiv[ao]|inconsistent|inconsistente|incomplete|incomplet[ao]',
    why: 'forbidden transitions, stale and impossible states',
  },
  {
    id: 'dependency-failure',
    signals:
      'fail|falla|fallo|failure|throw|lanza|timeout|crash|unavailable|no responde|' +
      'refuse|rechaza|unreadable|ilegible|broken|rot[ao]s?|enoent|denied by|' +
      'sin permiso|partial|parcial',
    why: 'what happens when a dependency refuses to cooperate',
  },
  {
    id: 'idempotency-order',
    signals:
      'twice|dos veces|repeat|repetid[ao]s?|again|de nuevo|idempot\\p{L}*|' +
      'concurren\\p{L}*|race|carrera|retry|reintent\\p{L}*|parallel|paralelo|' +
      'order|orden|reentr\\p{L}*|second time|segunda vez',
    why: 'the same operation twice, and operations in the wrong order',
  },
  {
    id: 'invariant',
    signals:
      'invariant|invariante|never|nunca|jam[aá]s|always|siempre|must not|no debe|' +
      'no puede|cannot|nunca deber[ií]a',
    why: 'what must NEVER happen, stated as a property instead of an example',
  },
  {
    id: 'security',
    signals:
      'auth|autenticaci[oó]n|permission|permiso|authorization|autorizaci[oó]n|bypass|' +
      'evade|evasi[oó]n|escape|traversal|inject|inyecci[oó]n|owner|due[nñ]o|' +
      'privile\\p{L}*|secret|credential|credencial|sandbox|escalad[ao]',
    why: 'the guard being walked around rather than triggered',
  },
  {
    id: 'decision-table',
    signals:
      'decision table|tabla de decisi[oó]n|combinaci\\p{L}*|combination|combined|' +
      'precedence|precedencia|both|ambos|neither|ninguno de los dos|excluyente|' +
      'mutually|overlap|solapa\\p{L}*|gana|wins|takes priority|tiene prioridad',
    why: 'every meaningful combination of the conditions, including the ones that collide',
  },
  {
    id: 'metamorphic',
    signals:
      'metamorphic|metam[oó]rfic[ao]s?|equivalen\\p{L}*|same result|mismo resultado|' +
      'does not change|no cambia|no altera|unchanged|sin cambiar|reorder|' +
      'reordena\\p{L}*|otro orden|irrelevant|irrelevante|scal(?:e|es|ed|ing)|escala\\p{L}*',
    why: 'a relation between two runs, when the exact expected output cannot be stated',
  },
  {
    id: 'partial-write',
    signals:
      'rollback|revert|revierte|atomic|at[oó]mic[ao]s?|partial write|escritura parcial|' +
      'a medias|half[- ]written|leftover|residuo|sobrante|side[- ]effect|' +
      'efecto secundario|never writes|no escribe|nunca escribe|cleanup|limpieza|' +
      'dirty|estado sucio',
    why: 'a failed operation leaving no half-written state and no leaked side effect',
  },
]);

const CATEGORY_BY_ID = new Map(
  ATTACK_CATEGORIES.map((category) => [category.id, category]),
);

/**
 * The rows a file must account for when a project declares nothing else. Listed by hand and
 * never derived from ATTACK_CATEGORIES, because adding a category to the catalog would
 * otherwise retroactively refuse every test file already on disk; a new row becomes
 * available to whoever asks for it by name, and widening this list stays a deliberate act.
 */
export const DEFAULT_REQUIRED_CATEGORIES = Object.freeze([
  'boundary',
  'invalid-input',
  'missing-empty',
  'invalid-state',
  'dependency-failure',
  'idempotency-order',
  'invariant',
  'security',
]);

export const KNOWN_CATEGORIES = Object.freeze(
  ATTACK_CATEGORIES.map((category) => category.id),
);

export const STATUS = Object.freeze({
  COVERED: 'covered',
  NOT_APPLICABLE: 'not-applicable',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
});

const HEADER_PATTERN = /attack\s+matrix/i;
// A row must be a COMMENT line so that a string inside a fixture can never pass as a
// declaration, and the words are joined with `\s+` (never a literal space) because a row
// typed with two spaces is the same row to a reader — the evasion
// cli/__tests__/gate-evasion.test.mjs caught three other gates losing.
// Every gap inside a row is `[ \t]` and never `\s`, because `\s` crosses the newline: a row
// left empty (`// boundary:`) swallowed the NEXT line and reported it as its own content.
const COMMENT_PREFIX = String.raw`^[ \t]*(?:\/\/+|\/\*|\*|#|--|;)[ \t]*(?:[-*][ \t]*)?`;
const ROW_SEPARATOR = String.raw`[ \t]*:[ \t]*(.*)$`;
const STATUS_PATTERNS = Object.freeze([
  [STATUS.COVERED, /^covered\b/i],
  [STATUS.NOT_APPLICABLE, /^(?:n\s*\/\s*a|na|not\s+applicable|no\s+aplica)\b/i],
  [STATUS.MISSING, /^missing\b/i],
]);
const REASON_SEPARATOR = /^[\s:\-–—]+/;
const MUTATIONS_PATTERN = new RegExp(
  `${COMMENT_PREFIX}mutations(?:[ \\t-]+killed)?${ROW_SEPARATOR}`,
  'im',
);
const MUTATION_SEPARATOR = /[,;]/;
// Two characters, because the shortest honest mutation entry is a pair of symbols (`>=`
// becoming `>`); anything shorter is a stray separator, never a named mutation.
const MIN_MUTATION_LENGTH = 2;
// Eight characters, because "no state" is about the shortest genuine reason and a shorter
// one ("no", "x") is a way to dismiss a whole category without saying anything.
const MIN_REASON_LENGTH = 8;

// The thresholds live here, and never only in the gate's params, so that a caller that
// passes no options is judged by the doctrine rather than by NaN comparisons that quietly
// approve everything.
export const DEFAULT_MIN_MUTATIONS = 3;
export const DEFAULT_MIN_ADVERSARIAL_RATIO = 0.5;

// Which paths are test files, and the marker that exempts one, live here and not in the
// gate, because the gate and any checker run over a whole tree must agree on what they are
// judging — two copies would drift and each would call a different set of files "tests".
export const TEST_PATH_PATTERN = String.raw`(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|[\\/])tests?\.[cm]?[jt]sx?)$`;
export const ESCAPE_HATCH = 'adversarial-tests:allow';

/**
 * Whether the file opts out. The marker only counts on a COMMENT line, because a fixture
 * that merely quotes it ("assert this content is exempt") would otherwise exempt the whole
 * suite that tests the escape hatch — which is exactly the file that must not be exempt.
 */
export function hasEscapeHatch(text, marker = ESCAPE_HATCH) {
  if (!marker) return false;
  return String(text ?? '')
    .split(/\r?\n/)
    .some((line) => COMMENT_LINE_PATTERN.test(line) && line.includes(marker));
}

export function isTestPath(path, pattern = TEST_PATH_PATTERN) {
  if (!path) return false;
  try {
    return new RegExp(pattern, 'i').test(String(path));
  } catch {
    return new RegExp(TEST_PATH_PATTERN, 'i').test(String(path));
  }
}

function escapeForRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function rowFor(text, id) {
  let pattern;
  try {
    pattern = new RegExp(
      `${COMMENT_PREFIX}${escapeForRegex(id)}${ROW_SEPARATOR}`,
      'im',
    );
  } catch {
    return null;
  }
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

function statusOf(declaration) {
  for (const [status, pattern] of STATUS_PATTERNS) {
    const match = pattern.exec(declaration);
    if (match) {
      return {
        status,
        reason: declaration
          .slice(match[0].length)
          .replace(REASON_SEPARATOR, '')
          .trim(),
      };
    }
  }
  return { status: STATUS.UNKNOWN, reason: declaration };
}

function mutationsIn(text) {
  const match = MUTATIONS_PATTERN.exec(text);
  if (!match) return [];
  return match[1]
    .split(MUTATION_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= MIN_MUTATION_LENGTH);
}

/**
 * The declaration a file carries. A row that was never written is left out of the map
 * instead of defaulted, so that "not declared" cannot be confused with "declared badly".
 */
export function parseAttackMatrix(text, requiredCategories) {
  const source = String(text ?? '');
  const ids = requiredCategories ?? DEFAULT_REQUIRED_CATEGORIES;
  const rows = new Map();
  for (const id of ids) {
    const declaration = rowFor(source, id);
    if (declaration !== null) rows.set(id, statusOf(declaration));
  }
  return {
    hasHeader: HEADER_PATTERN.test(source),
    rows,
    mutations: mutationsIn(source),
  };
}

// Only the FIRST argument of `test(...)`/`it(...)` counts as a title, because that string is
// what a reader auditing the suite actually sees.
const CASE_TITLE_PATTERN =
  /(?:^|[^\w.])(?:test|it)(?:\.\w+)?\s*\(\s*(['"`])([^'"`\n]*)\1/g;
const CASE_CALL_PATTERN = /(?:^|[^\w.])(?:test|it)(?:\.\w+)?\s*\(/g;
// Every literal is the wider evidence pool, because a table-driven suite keeps its case
// names in data and refusing to look there would punish the suites that are more rigorous.
const STRING_LITERAL_PATTERN = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;
// Comment lines are cut out of the evidence pool because otherwise the matrix corroborates
// itself: a row reading `invalid-input: COVERED — "invalid" payload` would be its own proof,
// and a commented-out case would count as a case. Only what the file actually RUNS counts.
const COMMENT_LINE_PATTERN = /^[ \t]*(?:\/\/|\*|#|--|;|\/\*)/;

function withoutCommentLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !COMMENT_LINE_PATTERN.test(line))
    .join('\n');
}

export function caseTitles(text) {
  return [...String(text ?? '').matchAll(CASE_TITLE_PATTERN)].map(
    (match) => match[2],
  );
}

export function countCases(text) {
  return [...withoutCommentLines(text).matchAll(CASE_CALL_PATTERN)].length;
}

function stringLiterals(text) {
  return [...String(text ?? '').matchAll(STRING_LITERAL_PATTERN)].map((match) =>
    match[0].slice(1, -1),
  );
}

const SIGNAL_CACHE = new Map();

function signalFor(id) {
  if (!SIGNAL_CACHE.has(id)) {
    const category = CATEGORY_BY_ID.get(id);
    SIGNAL_CACHE.set(
      id,
      category ? withUnicodeWordBoundary(category.signals) : null,
    );
  }
  return SIGNAL_CACHE.get(id);
}

/**
 * Whether any of `texts` names the attack `id` stands for. A category this module does not
 * know cannot be corroborated, so it is granted rather than used to block a project that
 * declared its own row.
 */
export function corroborates(texts, id) {
  const signal = signalFor(id);
  if (!signal) return true;
  return texts.some((text) => signal.test(text));
}

function isAdversarial(title) {
  return KNOWN_CATEGORIES.some((id) => corroborates([title], id));
}

function rowProblems(id, entry, evidence) {
  if (!entry) {
    return `row "${id}" is absent — declare it COVERED, or "N/A — <reason>". Never skip it.`;
  }
  if (entry.status === STATUS.MISSING) {
    return `row "${id}" is declared MISSING — the suite says itself it is incomplete. Write that case, or declare it "N/A — <reason>" if it truly cannot apply.`;
  }
  if (entry.status === STATUS.UNKNOWN) {
    return `row "${id}" has no readable status — use COVERED, "N/A — <reason>" or MISSING.`;
  }
  if (
    entry.status === STATUS.NOT_APPLICABLE &&
    entry.reason.length < MIN_REASON_LENGTH
  ) {
    return `row "${id}" is N/A with no reason — state why the category cannot apply here.`;
  }
  if (entry.status === STATUS.COVERED && !corroborates(evidence, id)) {
    return `row "${id}" claims COVERED but no case in this file names that attack — add the case, or rename the one that does it so a reader can find it.`;
  }
  return null;
}

const PERCENT = 100;

function ratioProblem(titles, minAdversarialRatio) {
  if (titles.length === 0) return null;
  const adversarial = titles.filter((title) => isAdversarial(title)).length;
  if (adversarial >= Math.ceil(titles.length * minAdversarialRatio))
    return null;
  return (
    `${adversarial} of ${titles.length} case titles attack something; the doctrine spends ` +
    `most of the budget off the happy path (at least ${Math.round(minAdversarialRatio * PERCENT)}%). ` +
    'Add the failing cases, or name the ones you have after what they break.'
  );
}

/**
 * Everything wrong with a file's adversarial evidence, as sentences an author can act on.
 * Empty means the file declares its matrix, backs each claim with a case, and names the
 * mutations it kills — never that the tests are good, which no static check can decide.
 */
export function attackMatrixProblems(text, options = {}) {
  const {
    requiredCategories = DEFAULT_REQUIRED_CATEGORIES,
    minMutations = DEFAULT_MIN_MUTATIONS,
    minAdversarialRatio = DEFAULT_MIN_ADVERSARIAL_RATIO,
  } = options;
  const source = String(text ?? '');
  const parsed = parseAttackMatrix(source, requiredCategories);
  if (!parsed.hasHeader) {
    return [
      'there is no ATTACK MATRIX block — nothing in this file says which attacks were tried, so nobody can check that any were.',
    ];
  }

  const body = withoutCommentLines(source);
  const titles = caseTitles(body);
  const evidence = [...titles, ...stringLiterals(body)];
  const problems = requiredCategories
    .map((id) => rowProblems(id, parsed.rows.get(id), evidence))
    .filter(Boolean);

  if (parsed.mutations.length < minMutations) {
    problems.push(
      `only ${parsed.mutations.length} mutation(s) on the "mutations-killed:" line; name at least ${minMutations} (e.g. ">= -> >", "&& -> ||", "validation removed") and keep only the ones a case here would actually catch.`,
    );
  }

  const ratio = ratioProblem(titles, minAdversarialRatio);
  if (ratio) problems.push(ratio);
  return problems;
}

/** The block an author pastes and fills in, so that a refusal always ships its remedy. */
export function attackMatrixSkeleton(requiredCategories, commentPrefix = '//') {
  const rows = (requiredCategories ?? DEFAULT_REQUIRED_CATEGORIES).map((id) => {
    const why = CATEGORY_BY_ID.get(id)?.why ?? 'what this row covers';
    return `${commentPrefix} ${id}: COVERED — <the case that does it>   (${why})`;
  });
  return [
    `${commentPrefix} ATTACK MATRIX — <what is under attack>`,
    ...rows,
    `${commentPrefix} mutations-killed: <e.g. >= -> >, && -> ||, validation removed>`,
  ].join('\n');
}
