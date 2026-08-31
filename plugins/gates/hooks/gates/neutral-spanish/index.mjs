import {
  runGate,
  deny,
  toolInGroups,
  writtenContentOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'neutral-spanish';
const CONFIG_KEY = 'warnNonNeutralSpanish';

const MAX_REPORTED_MARKERS = 8;

// Escape hatch: when a written file legitimately needs regional text (a literal quote, a
// test fixture, a captured log, a data sample), placing this marker anywhere in the content
// tells the gate the regional wording is intentional and lets the write through. A deny (as
// opposed to the old warn) cannot "advise and let pass", so a legitimate case needs an
// explicit, greppable opt-out — a marker the author writes on purpose, never one the agent
// could infer. A project can override it via config (escapeHatch).
const DEFAULT_ESCAPE_HATCH = 'neutral-spanish:allow';

// Data strings, not identifiers — never add these to a cSpell dictionary.
// neutral-spanish:allow — this list IS the marker data; the gate must not deny its own source.
// Now that this gate DENIES (not warns), a marker must be unambiguously regional. Tokens that
// also occur in neutral Spanish were removed: "de una" (matches "de una lista/vez"), "allá"
// (standard across the whole language) — a false positive here blocks a legitimate write.
const DEFAULT_REGIONAL_MARKERS = [
  'tenés',
  'podés',
  'querés',
  'sabés',
  'hacés',
  'decís',
  'venís',
  'sos',
  'fijate',
  'mirá',
  'pará',
  'esperá',
  'dale',
  'mandale',
  'contame',
  'fíjate vos',
  'acá',
  'laburo',
  'laburar',
  'quilombo',
  'posta',
  'che',
  'boludo',
  'pibe',
  'guita',
  'al pedo',
  'un toque',
  'capaz que', // neutral-spanish:allow (marker data, not prose)
];

function extractText(toolName, toolInput) {
  if (!toolInGroups(toolName, ['write'])) return '';
  return writtenContentOf(toolInput);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      regionalMarkers: DEFAULT_REGIONAL_MARKERS,
      escapeHatch: DEFAULT_ESCAPE_HATCH,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const text = extractText(toolName, toolInput).toLowerCase();
    if (!text) return;

    // Explicit opt-out for legitimate regional text (quote/fixture/log/data sample).
    const escapeHatch = (
      parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH
    ).toLowerCase();
    if (escapeHatch && text.includes(escapeHatch)) return;

    const hits = [];
    for (const marker of parameters.regionalMarkers) {
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // \p{L} (any Unicode letter) as the non-boundary class, instead of a hand-written
      // accented-character set, so accented word boundaries are handled correctly without
      // spelling out literal accented characters in the source (the project keeps its
      // spell-check dictionary untouched, so no word list may lean on this being a string).
      const pattern = new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, 'iu');
      if (pattern.test(text)) hits.push(marker);
    }

    if (hits.length === 0) return;

    const unique = [...new Set(hits)].slice(0, MAX_REPORTED_MARKERS);
    deny(
      GATE_ID,
      `Text being written contains regional Spanish markers: ${unique.join(', ')}. ` +
        'Rewrite in neutral Spanish before writing. If the regional wording is intentional ' +
        `(a literal quote, a test fixture, a captured log, a data sample), add the marker ` +
        `"${parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH}" somewhere in the content to allow it.`,
    );
  },
);
