import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGate, deny, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'recurrence-lock';
const CONFIG_KEY = 'blockRegisteredRecurrences';

/**
 * De-duplicates occurrences before counting them against the threshold. An occurrence is
 * identified by its `id`/`hash` field when present (the intended identity for a logged
 * occurrence); a bare-scalar entry (number/string, as in the plain fixture shape used by
 * tests) is deduplicated by its own value instead, since it carries no other identity.
 * Without this, the same occurrence logged twice (a race or a bug in the writer) inflates
 * the count and trips the lock as if two distinct occurrences had happened.
 */
function dedupOccurrences(occurrences) {
  const seen = new Set();
  const deduped = [];
  for (const occurrence of occurrences) {
    const identity =
      occurrence && typeof occurrence === 'object'
        ? String(occurrence.id ?? occurrence.hash ?? JSON.stringify(occurrence))
        : String(occurrence);
    if (seen.has(identity)) continue;
    seen.add(identity);
    deduped.push(occurrence);
  }
  return deduped;
}

// The source guard (guard-reincidence-lock.mjs) reads pending recurrences
// from a full tracking module (../scripts/memory/recurrences.mjs) with
// close/decide/pending subcommands. That infrastructure belongs to another
// project and does not exist here. This gate only reads a plain state file
// at .ai/reincidencias.json if present, with the shape:
//   { classes: [{ class, occurrences: [...], status }] }
// If neither the module nor the file exists, it allows silently — there is
// nothing to enforce without a recurrence record.
function loadOpenRecurrences(projectRoot, thresholdAppearances) {
  const filePath = join(projectRoot, '.ai', 'reincidencias.json');
  if (!existsSync(filePath)) return [];

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }

  const classes = Array.isArray(parsed?.classes) ? parsed.classes : [];
  return classes.filter((entry) => {
    const occurrences = Array.isArray(entry?.occurrences)
      ? dedupOccurrences(entry.occurrences)
      : [];
    const occurrenceCount = occurrences.length;
    // Trim before lowercasing so a padded status ("Closed ", "cerrada\n") is recognized —
    // a status compared without trimming left a validly-closed (but padded) recurrence
    // stuck as still-open, blocking unrelated work indefinitely.
    const status = String(entry?.status ?? '')
      .trim()
      .toLowerCase();
    const isClosed = status === 'closed' || status === 'cerrada';
    return occurrenceCount >= thresholdAppearances && !isClosed;
  });
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      thresholdAppearances: 2,
    },
  },
  ({ toolName, parameters }) => {
    if (!toolInGroups(toolName, ['execution', 'delegation'])) return;

    const recurrencesFile = join('.ai', 'reincidencias.json');
    const openRecurrences = loadOpenRecurrences(
      process.cwd(),
      parameters.thresholdAppearances,
    );
    if (openRecurrences.length === 0) return;

    const names = openRecurrences.map((entry) => entry.class).join(', ');
    deny(
      CONFIG_KEY,
      `Registered recurring issue class(es) still open and at/above the ` +
        `${parameters.thresholdAppearances}-occurrence threshold: ${names}. Fix the root ` +
        `cause of the class (not this one instance), then in ${recurrencesFile} set that ` +
        'class\'s "status" to "closed" (or "cerrada") before proceeding — no other file to ' +
        'find, this is the only source this gate reads.',
    );
  },
);
