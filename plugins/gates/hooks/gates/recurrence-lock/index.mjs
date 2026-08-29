import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'recurrence-lock';
const CONFIG_KEY = 'blockRegisteredRecurrences';

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
    const occurrenceCount = Array.isArray(entry?.occurrences)
      ? entry.occurrences.length
      : 0;
    const status = String(entry?.status ?? '').toLowerCase();
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
    const isExecution = TOOL_GROUPS.execution.includes(toolName);
    const isDelegation = TOOL_GROUPS.delegation.includes(toolName);
    if (!isExecution && !isDelegation) return;

    const openRecurrences = loadOpenRecurrences(
      process.cwd(),
      parameters.thresholdAppearances,
    );
    if (openRecurrences.length === 0) return;

    const names = openRecurrences.map((entry) => entry.class).join(', ');
    deny(
      GATE_ID,
      `Registered recurring issue classes are still open and at/above threshold: ${names}. Resolve or close them before proceeding.`,
    );
  },
);
