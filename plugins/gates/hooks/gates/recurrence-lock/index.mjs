// recurrence-lock — while a registered defect class is open and at/above the threshold,
// mutating work is denied until its root cause is closed. Whatever is needed to CLOSE the
// class stays allowed (editing the recurrence file, read-only inspection, read-only
// delegation), otherwise the lock would deadlock on its own remedy.

import { basename, join } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import { isExemptQuery } from '../../lib/delegation.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  writtenPathOf,
  shellCommandOf,
  shellWrittenPaths,
  delegationPromptOf,
} from '../../lib/hook-io.mjs';
import {
  isReadOnlyCommand,
  isSelfRemedyCommand,
} from '../../lib/shell-safety.mjs';

const GATE_ID = 'recurrence-lock';
const CONFIG_KEY = 'blockRegisteredRecurrences';

const RECURRENCES_FILE = 'reincidencias.json';
const RECURRENCES_RELATIVE_PATH = join('.ai', RECURRENCES_FILE);
const DEFAULT_THRESHOLD = 2;

function isExemptCall(toolName, toolInput) {
  if (toolInGroups(toolName, ['write']))
    return basename(writtenPathOf(toolInput)) === RECURRENCES_FILE;
  if (toolInGroups(toolName, ['shell'])) {
    const command = shellCommandOf(toolInput);
    // because this gate exempted read-only commands but not the toolkit's own task and
    // config commands, it still deadlocked by a second route (gate-invariants caught it).
    if (isSelfRemedyCommand(command)) return true;
    return isReadOnlyCommand(command, {
      writesPaths: shellWrittenPaths(command).length > 0,
    });
  }
  if (toolInGroups(toolName, ['delegation']))
    return isExemptQuery(delegationPromptOf(toolInput));
  return false;
}

// Identity is id/hash when present, else the value itself: the same occurrence logged
// twice must not count as two.
function dedupOccurrences(occurrences) {
  const seen = new Set();
  return occurrences.filter((occurrence) => {
    const identity =
      occurrence && typeof occurrence === 'object'
        ? String(occurrence.id ?? occurrence.hash ?? JSON.stringify(occurrence))
        : String(occurrence);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function isClosed(entry) {
  const status = String(entry?.status ?? '')
    .trim()
    .toLowerCase();
  return status === 'closed' || status === 'cerrada';
}

function loadOpenRecurrences(root, thresholdAppearances) {
  const parsed = readJsonOrNull(join(root, RECURRENCES_RELATIVE_PATH));
  const classes = Array.isArray(parsed?.classes) ? parsed.classes : [];
  return classes.filter((entry) => {
    const occurrences = Array.isArray(entry?.occurrences)
      ? dedupOccurrences(entry.occurrences)
      : [];
    return occurrences.length >= thresholdAppearances && !isClosed(entry);
  });
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      thresholdAppearances: DEFAULT_THRESHOLD,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['execution', 'delegation'])) return;
    if (isExemptCall(toolName, toolInput)) return;

    const root = projectRootOf(cwd) ?? cwd;
    const openRecurrences = loadOpenRecurrences(
      root,
      parameters.thresholdAppearances,
    );
    if (openRecurrences.length === 0) return;

    const names = openRecurrences.map((entry) => entry.class).join(', ');
    deny(
      CONFIG_KEY,
      `Registered recurring issue class(es) still open and at/above the ` +
        `${parameters.thresholdAppearances}-occurrence threshold: ${names}. Fix the root ` +
        `cause of the class (not this one instance), then in ${RECURRENCES_RELATIVE_PATH} set that ` +
        'class\'s "status" to "closed" (or "cerrada") before proceeding — editing that file, ' +
        'read-only commands (git status/log/diff, cat, grep, tests) and read-only delegations ' +
        'stay allowed so you can do exactly that.',
    );
  },
);
