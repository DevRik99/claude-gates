// neutral-spanish — regional Spanish (voseo, Rioplatense lexicon) is denied in Spanish
// prose. Only prose is scanned: a text-type file, or content carrying enough Spanish
// function words to be Spanish — so an English "Author: Dale Carnegie" in code is not a
// marker hit. A deliberate quote/fixture/log opts out with the escape-hatch marker.

import { extname } from 'node:path';
import {
  runGate,
  deny,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
  escapeRegExp,
} from '../../lib/hook-io.mjs';
import { withUnicodeWordBoundary } from '../../lib/signals.mjs';

const GATE_ID = 'neutral-spanish';
const CONFIG_KEY = 'warnNonNeutralSpanish';

const MAX_REPORTED_MARKERS = 8;
const MIN_SPANISH_FUNCTION_WORDS = 3;
const DEFAULT_ESCAPE_HATCH = 'neutral-spanish:allow';
const DEFAULT_TEXT_EXTENSIONS = [
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.html',
  '.htm',
  '.adoc',
  '.json',
  '.yml',
  '.yaml',
];

const SPANISH_FUNCTION_WORD = withUnicodeWordBoundary(
  'que|de|la|el|los|las|para|con|una|por|como|también|está|más|este|esta|hay|muy|sin',
);

// Data strings, not identifiers — never add these to a cSpell dictionary.
// neutral-spanish:allow — this list IS the marker data; the gate must not deny its own source.
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

function isSpanishProse(text) {
  const global = new RegExp(
    SPANISH_FUNCTION_WORD.source,
    `${SPANISH_FUNCTION_WORD.flags}g`,
  );
  const distinct = new Set();
  for (const match of text.matchAll(global)) {
    distinct.add(match[0].toLowerCase());
    if (distinct.size >= MIN_SPANISH_FUNCTION_WORDS) return true;
  }
  return false;
}

function hasTextExtension(path, textExtensions) {
  const extension = extname(path).toLowerCase();
  return textExtensions.some(
    (candidate) => String(candidate).toLowerCase() === extension,
  );
}

function markerHits(text, markers) {
  const hits = [];
  for (const marker of markers) {
    if (typeof marker !== 'string' || marker.length === 0) continue;
    if (withUnicodeWordBoundary(escapeRegExp(marker)).test(text))
      hits.push(marker);
  }
  return hits;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      regionalMarkers: DEFAULT_REGIONAL_MARKERS,
      textExtensions: DEFAULT_TEXT_EXTENSIONS,
      escapeHatch: DEFAULT_ESCAPE_HATCH,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['write'])) return;
    const text = writtenContentOf(toolInput);
    if (!text) return;

    const escapeHatch = parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH;
    if (escapeHatch && text.toLowerCase().includes(escapeHatch.toLowerCase()))
      return;

    const path = writtenPathOf(toolInput);
    if (
      !hasTextExtension(path, parameters.textExtensions) &&
      !isSpanishProse(text)
    )
      return;

    const hits = markerHits(text, parameters.regionalMarkers);
    if (hits.length === 0) return;

    const unique = [...new Set(hits)].slice(0, MAX_REPORTED_MARKERS);
    deny(
      CONFIG_KEY,
      `Text being written contains regional Spanish markers: ${unique.join(', ')}. ` +
        'Rewrite in neutral Spanish before writing. If the regional wording is intentional ' +
        '(a literal quote, a test fixture, a captured log, a data sample), add the marker ' +
        `"${escapeHatch}" somewhere in the content to allow it.`,
    );
  },
);
