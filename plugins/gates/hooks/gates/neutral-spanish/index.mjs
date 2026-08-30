import { runGate, warn, toolInGroups, writtenContentOf } from '../../lib/hook-io.mjs';

const GATE_ID = 'neutral-spanish';
const CONFIG_KEY = 'warnNonNeutralSpanish';

const MAX_REPORTED_MARKERS = 8;

// Data strings, not identifiers — never add these to a cSpell dictionary.
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
  'allá',
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
  'capaz que',
  'de una',
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
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const text = extractText(toolName, toolInput).toLowerCase();
    if (!text) return;

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
    warn(
      GATE_ID,
      `Text being written contains regional Spanish markers: ${unique.join(', ')}. Prefer neutral Spanish unless this is a literal quote or data.`,
    );
  },
);
