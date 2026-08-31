// signals.mjs — central catalog of LEXICAL prose signals, each covering Spanish AND
// English, for every gate that matches free text (briefs, delegation prompts, written
// content). Written once here; gates import instead of keeping their own monolingual or
// partially-bilingual copy.
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

/** Unicode-aware word boundary: matches only when the alternation is not adjacent to
 * another letter/digit/underscore, so short terms cannot match as a substring of a
 * longer unrelated word. */
export function withUnicodeWordBoundary(alternatives) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`,
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
  `write|escrib|${DESTRUCTIVE_DEPLOY_TERMS}`;

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

// ── PERSISTENCE_VERB: an instruction to save/persist/store something ────────────────
// Used to detect a REAL persistence instruction nearby a memory-dependency phrase (see
// no-memory-dependency), so a bare mention of a memory phrase with a genuine "save this
// to <file>" nearby is not flagged as depending on model memory.

export const PERSISTENCE_VERB_SOURCES = [
  'save|persist|store',
  'guarda(?:l[oa])?|guard[aá]|persist[eií]|persistir|persistido|almacena|almacenar',
  'escrib(?:e|í|i) .{0,20}en|escribir .{0,20}en|write .{0,20}(?:to|in)',
  'anota|anotar|registra|registrar',
];

export const PERSISTENCE_VERB = new RegExp(
  PERSISTENCE_VERB_SOURCES.join('|'),
  'iu',
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
  const verbMatch = BUILD_VERB.exec(text);
  if (!verbMatch) return false;
  const after = text.slice(
    verbMatch.index + verbMatch[0].length,
    verbMatch.index + verbMatch[0].length + BUILD_INTENT_MAX_GAP,
  );
  return BUILDABLE_NOUN.test(after);
}
