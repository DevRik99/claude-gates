// signals.mjs — central catalog of LEXICAL prose signals, each covering Spanish AND
// English, for every gate that matches free text (briefs, delegation prompts, written
// content). Written once here; gates import instead of keeping their own monolingual or
// partially-bilingual copy.
//
// The Spanish below is DATA, not prose: these are the terms the gates match against a user's
// own words, so they cannot be translated without making every gate monolingual.
//
// ── Scope: lexical only ──────────────────────────────────────────────────────────────
// A gate whose real signal lives in the ACTION (a shell command, a tool name, a file
// path) keeps using structural detection for that part — this module does not replace
// toolInGroups/writtenPathOf/etc., and a gate should prefer the structural check first
// wherever the signal is genuinely structural. This module exists for the remaining
// case: prose written by a human or a model, in either language, that a gate must
// recognize regardless of which language it was written in.
//
// ── Honest limitation ────────────────────────────────────────────────────────────────
// Coverage is ES + EN only. A prompt written in a third language (or a language-neutral
// paraphrase using none of these terms) is NOT covered by any pattern here — this module
// closes the specific ES/EN gap the gates had, it does not claim language-agnostic
// detection. Where the underlying signal can instead be read off the action itself
// (structural), that stays the primary defense; lexical matching is the fallback layer
// for prose that never had a structural signal to read.
//
// ── Word-boundary and accent handling ────────────────────────────────────────────────
// `withUnicodeWordBoundary` uses lookarounds over `\p{L}|\p{N}|_` (not `\b`, which does
// not treat accented letters as word characters) so short/dangerous terms ("auth",
// "prod") require a full word match and do not fire inside "autor" or "producto".
// Spanish terms that carry an accent in correct spelling (contraseña, sesión, migración)
// are matched with an optional accent (`sesi[oó]n`) because normalized/ASCII input is
// common in prompts and commit messages.

// A literal space becomes `\s+` because a multi-word marker written with two spaces, or
// wrapped across a line, is the same phrase to a reader and evaded the pattern entirely —
// cli/__tests__/gate-evasion.test.mjs found three gates losing their match to exactly that.
// `\s+` still matches the single space, so no existing hit is lost.
export function withFlexibleSpaces(source) {
  return String(source).replace(/ +/g, String.raw`\s+`);
}

/** Unicode-aware word boundary: matches only when the alternation is not adjacent to
 * another letter/digit/underscore, so short terms cannot match as a substring of a
 * longer unrelated word. */
export function withUnicodeWordBoundary(alternatives) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${withFlexibleSpaces(alternatives)})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

// ── RISK_SIGNAL: high-impact mutation area (money / auth / destructive-deploy) ───────
// Used where a gate must recognize that a request touches a sensitive domain,
// regardless of whether it was phrased in Spanish or English. Three sub-domains kept
// separate so a gate can compose only the ones it needs, and one combined export for
// gates that want the whole class.

const MONEY_TERMS =
  'money|payment|pago|dinero|cobro|charge|invoice|factura|precio|price|saldo|balance|amount|monto';

const AUTH_TERMS =
  'auth|autenticaci[oó]n|authentication|credencial|credential|contrase[nñ]a|password|' +
  'token|sesi[oó]n|session|permiso|permission|role|rol';

const DESTRUCTIVE_DEPLOY_TERMS =
  'deploy|desplieg(?:a|ue|ar)?|producci[oó]n|production|prod|borrar|delete|drop|truncate|' +
  'migraci[oó]n|migration|migrate|migr(?:a|ar)|eliminar';

export const MONEY_SIGNAL = withUnicodeWordBoundary(MONEY_TERMS);
export const AUTH_SIGNAL = withUnicodeWordBoundary(AUTH_TERMS);
export const DESTRUCTIVE_DEPLOY_SIGNAL = withUnicodeWordBoundary(
  DESTRUCTIVE_DEPLOY_TERMS,
);

/** Combined high-impact mutation signal: money OR auth OR a destructive/deploy verb. */
export const RISK_SIGNAL = withUnicodeWordBoundary(
  `${MONEY_TERMS}|${AUTH_TERMS}|${DESTRUCTIVE_DEPLOY_TERMS}`,
);

/** RISK_SIGNAL as plain regex-source alternatives (no boundary/flags), for gates that
 * build their own combined pattern (e.g. joined with other domain-specific sources). */
export const RISK_SIGNAL_SOURCES = [
  MONEY_TERMS,
  AUTH_TERMS,
  DESTRUCTIVE_DEPLOY_TERMS,
];

// ── MUTATION_RISK_SIGNAL: broader than RISK_SIGNAL, used only to VOID an exemption ──
// Several gates let a whitelisted read-only subagent name (or an exempt-query verb)
// skip their check — but only when the prompt itself carries no mutation risk. That
// exemption-voiding check is deliberately broader than RISK_SIGNAL: it also counts a
// bare "data"/"datos"/"write"/"escrib*" mention, because the name/label is unverified
// and a false positive here only means the underlying check still runs (cheap), while a
// false negative would let a real mutator dodge the check via a trusted-sounding label.
// Kept as a distinct export from RISK_SIGNAL because the two answer different
// questions (RISK_SIGNAL: "is this domain high-impact?" vs MUTATION_RISK_SIGNAL: "is it
// unsafe to trust this label/verb at all?").
const MUTATION_RISK_TERMS =
  `${MONEY_TERMS}|${AUTH_TERMS}|credencial|credential|data|datos|borrar|delete|drop|` +
  `write|escrib\\p{L}*|${DESTRUCTIVE_DEPLOY_TERMS}`;

export const MUTATION_RISK_SIGNAL =
  withUnicodeWordBoundary(MUTATION_RISK_TERMS);

// ── CONJECTURE: never-assume phrasing ────────────────────────────────────────────────
// Prose stating an unverified assumption instead of a checked fact.

export const CONJECTURE_SOURCES = [
  'i assume',
  'assuming that',
  'probably',
  'i guess',
  'should be',
  "i'll default to",
  'might be',
  'supongo',
  'asumo',
  'asumiendo que',
  'probablemente',
  'deber[ií]a ser',
  'quiz[aá]s',
  'tal vez',
  'creo que',
  'me imagino que',
];

export const CONJECTURE = withUnicodeWordBoundary(CONJECTURE_SOURCES.join('|'));

// Because the reminder exists to get an unmarked guess marked, text that already labels its
// own uncertainty has nothing left to be reminded of: telling someone who wrote
// "hypothesis, unverified: probably X" to stop assuming is pure noise.
export const UNCERTAINTY_LABEL_SOURCES = [
  'hypothesis',
  'hip[oó]tesis',
  'conjecture',
  'conjetura',
  'unverified',
  'sin verificar',
  'not verified',
  'no verificad[oa]',
  'to be confirmed',
  'a confirmar',
  'por confirmar',
  'needs checking',
  'hay que verificar',
  'guess:',
  'assumption:',
  'supuesto:',
];

// ── UNVERIFIED_CLAIM: asserting DONE or CORRECT, which conjecture phrasing misses ────
// "probably" announces itself as a guess. "already works" does the opposite: it states a
// fact nobody checked, and reads as settled to whoever comes next. That is the assumption
// that actually costs — a brief telling a subagent the parser is done sends it to build on
// something that may not exist.
//
// Deliberately narrower than CONJECTURE: these fire only on a claim about STATE (done,
// works, fine, correct), never on ordinary description, because a false positive here
// blocks rather than advises.
export const UNVERIFIED_CLAIM_SOURCES = [
  'already (?:works|done|fixed|implemented|handled|covered)',
  "it'?s (?:done|fixed|working|fine)",
  'works (?:fine|now|correctly)',
  'looks (?:good|fine|correct|right)',
  'lgtm',
  'all (?:set|good)',
  'no issues',
  'everything (?:works|passes)',
  'tested and working',
  'ya (?:funciona|est[aá] (?:hecho|listo|resuelto))',
  'est[aá] (?:bien|correcto|hecho|listo|resuelto)',
  'se ve bien',
  'parece correcto',
  'todo (?:bien|listo|funciona)',
  'sin problemas',
  'funciona correctamente',
];

export const UNVERIFIED_CLAIM = withUnicodeWordBoundary(
  UNVERIFIED_CLAIM_SOURCES.join('|'),
);

// What turns a claim into a report: something a reader could re-check. Kept tight on
// purpose — a backtick or the word "ran" would match almost any prose and void the rule.
export const EVIDENCE_SOURCES = [
  'exit\\s*(?:code\\s*)?[0-9]+',
  '[0-9]+\\s*/\\s*[0-9]+',
  'tests?\\s+(?:pass|passed|passing)',
  'verified',
  'verificad[oa]',
  '--check',
  '--exists',
  'npm (?:test|run lint)',
];

export const EVIDENCE = withUnicodeWordBoundary(EVIDENCE_SOURCES.join('|'));

// ── PERSISTENCE_VERB: an instruction to save/persist/store something ────────────────
// Used to detect a REAL persistence instruction nearby a memory-dependency phrase (see
// no-memory-dependency), so a bare mention of a memory phrase with a genuine "save this
// to <file>" nearby is not flagged as depending on model memory.

export const PERSISTENCE_VERB_SOURCES = [
  'sav(?:e|es|ed|ing)|persist\\p{L}*|stor(?:e|es|ed|ing)',
  'guard\\p{L}*|almacen\\p{L}*',
  'escrib\\p{L}* .{0,20}en|writ(?:e|es|ing) .{0,20}(?:to|in)',
  'anot(?:a|á|ar|alo|en)|registr(?:a|á|ar|alo|en)',
];

export const PERSISTENCE_VERB = withUnicodeWordBoundary(
  PERSISTENCE_VERB_SOURCES.join('|'),
);

// ── BUILD_INTENT: a request to CREATE a tool/helper (reuse-before-build) ─────────────
// A verb of creation FOLLOWED SHORTLY BY a "buildable thing" noun, in Spanish AND English.
// The old pattern was English-only (write|create|build + script|gate|hook...), so a Spanish
// brief ("armá un verificador", "hacé un helper") never tripped the reuse check.
//
// Split into two small regexes (a creation verb, and a tool noun) checked with a bounded gap
// between them, rather than one large alternation. One monolithic pattern tripped the linter's
// regex-complexity budget; two short ones stay well under it and read more clearly. The gap
// (up to ~24 chars) lets an article/adjective sit between them ("build a new tool", "armá un
// verificador nuevo") while keeping the noun anchored to the verb so "write a report" /
// "escribí un correo" (non-tool nouns) do not match. Each side is word-boundary wrapped.
const BUILD_VERB = withUnicodeWordBoundary(
  'write|create|build|implement|add|make|' +
    'escribe|escribi|escribir|crea|construye|construir|implementa|implementar|' +
    'agrega|arma|hace|genera|generar|' +
    // voseo / accented imperative forms spelled as literals (no [aá] class, which the linter
    // counts against regex complexity): armá, hacé, creá, agregá, generá, escribí, construí.
    'armá|hacé|creá|agregá|generá|escribí|construí',
);
const BUILDABLE_NOUN = withUnicodeWordBoundary(
  'scripts?|verifiers?|gates?|hooks?|linters?|checkers?|tools?|helpers?|utilit(?:y|ies)|' +
    'utils?|composables?|components?|services?|wrappers?|' +
    'verificador(?:es)?|chequeador(?:es)?|herramientas?|utilidades?|ayudantes?|' +
    'envoltorios?|componentes?|servicios?',
);
const BUILD_INTENT_MAX_GAP = 24;

/** Whether the text expresses intent to CREATE a tool/helper (a creation verb closely
 * followed by a tool noun), in Spanish or English. A method, not a bare regex, so each side
 * stays a small pattern and the "verb → noun proximity" rule is explicit. */
export function isBuildIntent(text) {
  const source = String(text ?? '');
  const verbs = source.matchAll(
    new RegExp(BUILD_VERB.source, `${BUILD_VERB.flags}g`),
  );
  for (const verbMatch of verbs) {
    const start = verbMatch.index + verbMatch[0].length;
    // Extend the window to the end of the word it lands in, so a noun is never cut in half
    // ("components" must not match as "component" merely because the window ended there).
    let end = start + BUILD_INTENT_MAX_GAP;
    while (end < source.length && /[\p{L}\p{N}_]/u.test(source[end])) end += 1;
    if (BUILDABLE_NOUN.test(source.slice(start, end))) return true;
  }
  return false;
}

// ── WORK_NATURE: what KIND of work a prompt is asking for ───────────────────────────
// Used by capability-map to answer "did the nature of the work change?" — the trigger the
// catalog injection was missing. Its previous re-injection rule fired only when the
// CATALOG changed on disk, so a session that pivoted from debugging to designing kept
// whatever stale reminder the throttle had last emitted.
//
// This is a coarse lexical classifier, and deliberately so: a wrong answer costs one
// extra (harmless, never-blocking) injection of a catalog the model can ignore, so the
// bar for a term is "does it usually signal this kind of work", not certainty. Order
// matters for ties — the more specific natures are declared before the generic ones,
// because `implement`'s verbs (write/create/add) also appear inside every other nature.

const WORK_NATURE_TERMS = [
  [
    'debug',
    'debug|debugg\\p{L}*|depur\\p{L}*|bug|bugs|error|errores|falla|fallas|fallando|' +
      'broken|roto|rota|crash|crashes|traceback|stacktrace|reproduce|reproducir|' +
      'arregl\\p{L}*|corrig\\p{L}*|corregir|fix|fixes|fixing|diagnos\\p{L}*',
  ],
  [
    'test',
    'test|tests|testing|prueba|pruebas|probar|spec|specs|coverage|cobertura|' +
      'assert|asserts|asercion\\p{L}*|jest|vitest|mocha|pytest|e2e|fixture|fixtures',
  ],
  [
    'review',
    'review|reviews|revis\\p{L}*|auditor\\p{L}*|audit|audita|lint|linter|' +
      'code review|pull request|diff',
  ],
  [
    'release',
    'deploy|desplieg\\p{L}*|release|publica|publicar|publish|ship|version|versionar|' +
      'changelog|commit|merge|tag|rollout',
  ],
  [
    'refactor',
    'refactor\\p{L}*|simplif\\p{L}*|clean up|limpi\\p{L}*|renombr\\p{L}*|rename|' +
      'extract|extraer|deduplicat\\p{L}*|reorganiz\\p{L}*|migrate|migrar',
  ],
  [
    'design',
    'design|dise[nñ]\\p{L}*|mockup|wireframe|layout|maqueta|estilo|estilos|' +
      'css|tailwind|figma|paleta|palette|tipograf\\p{L}*|responsive',
  ],
  [
    'docs',
    'readme|changelog|documenta\\p{L}*|documentation|docstring|tutorial|guide|gu[ií]a|' +
      'manual|comentar|comment|comments',
  ],
  [
    'research',
    'research|investig\\p{L}*|explor\\p{L}*|explore|averigu\\p{L}*|analiz\\p{L}*|' +
      'analyze|analysis|compare|comparar|evalu\\p{L}*|study|estudiar|find out|' +
      'entender|understand|search|buscar',
  ],
  [
    'implement',
    'implement\\p{L}*|build|construi\\p{L}*|construye|create|crear|crea|' +
      'write|escrib\\p{L}*|add|agreg\\p{L}*|a[nñ]ad\\p{L}*|feature|funcionalidad|' +
      'endpoint|componente|component|integra\\p{L}*',
  ],
];

const GENERAL_WORK_NATURE = 'general';

const WORK_NATURE_PATTERNS = WORK_NATURE_TERMS.map(([nature, terms]) => [
  nature,
  new RegExp(withUnicodeWordBoundary(terms).source, 'giu'),
]);

/**
 * The dominant kind of work a text is asking for, or 'general' when nothing matches.
 * Scored by how many nature terms occur, so a passing mention loses to a sustained one;
 * ties go to whichever nature is declared first (most specific wins).
 */
export function workNatureOf(text) {
  const source = String(text ?? '');
  if (!source.trim()) return GENERAL_WORK_NATURE;
  let best = GENERAL_WORK_NATURE;
  let bestScore = 0;
  for (const [nature, pattern] of WORK_NATURE_PATTERNS) {
    pattern.lastIndex = 0;
    const score = [...source.matchAll(pattern)].length;
    if (score > bestScore) {
      best = nature;
      bestScore = score;
    }
  }
  return best;
}
