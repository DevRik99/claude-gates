// diagnosis-before-patch — a timeout/deadline/retry value that CHANGES gets a reminder to
// bring the evidence first. Only a change counts: a new file, or a value that stays as it
// is on disk, is not a symptom being patched. Advisory only, never a block.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  runGate,
  warn,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
  compileRegexList,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'diagnosis-before-patch';
const CONFIG_KEY = 'warnTimeoutChangeWithoutDiagnosis';

const DEFAULT_TIMEOUT_PATTERNS = [
  String.raw`\b[A-Z_]*TIMEOUT[A-Z_]*\s*[:=]\s*['"]?\d`,
  String.raw`\b[A-Z_]*DEADLINE[A-Z_]*\s*[:=]\s*['"]?\d`,
  String.raw`\b[A-Z_]*IDLE[A-Z_]*\s*[:=]\s*['"]?\d`,
  String.raw`\b(max_?retry|retries|backoff)\b\s*[:=]\s*['"]?\d`,
  String.raw`\b(query_?timeout|hard_?deadline)\b`,
];

// From a pattern hit, the key and the numeric value that follows it (value may be empty).
const ASSIGNMENT_PATTERN = /^([\w.$-]+)\s*[:=]?\s*['"]?([\d.]*)/;
const ASSIGNMENT_WINDOW = 200;

function assignmentsIn(text, patterns) {
  const values = new Map();
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of text.matchAll(global)) {
      const slice = text.slice(match.index, match.index + ASSIGNMENT_WINDOW);
      const assignment = ASSIGNMENT_PATTERN.exec(slice);
      if (!assignment) continue;
      const [, key, value] = assignment;
      if (!values.has(key)) values.set(key, value);
    }
  }
  return values;
}

function changedKeys(before, after) {
  const changes = [];
  for (const [key, value] of after) {
    if (before.has(key) && before.get(key) !== value)
      changes.push({ key, from: before.get(key), to: value });
  }
  return changes;
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// Edit-style tools carry old/new pairs; anything else is compared with the file on disk.
function beforeAfterPairs(toolInput, root) {
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits.map((edit) => [
      String(edit?.old_string ?? ''),
      String(edit?.new_string ?? ''),
    ]);
  }
  if (typeof toolInput.old_string === 'string') {
    return [[toolInput.old_string, writtenContentOf(toolInput)]];
  }
  const path = writtenPathOf(toolInput);
  if (!path) return [];
  const onDisk = readTextOrNull(isAbsolute(path) ? path : join(root, path));
  return onDisk === null ? [] : [[onDisk, writtenContentOf(toolInput)]];
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    severity: 'warn',
    defaultParams: {
      timeoutPatterns: DEFAULT_TIMEOUT_PATTERNS,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['write'])) return;
    const { patterns } = compileRegexList(parameters.timeoutPatterns);
    if (patterns.length === 0) return;

    const root = projectRootOf(cwd) ?? cwd;
    const changes = beforeAfterPairs(toolInput, root).flatMap(
      ([before, after]) =>
        changedKeys(
          assignmentsIn(before, patterns),
          assignmentsIn(after, patterns),
        ),
    );
    if (changes.length === 0) return;

    const filePath = writtenPathOf(toolInput) || '(unknown path)';
    const described = changes
      .map((change) => `${change.key}: ${change.from} -> ${change.to}`)
      .join(', ');
    warn(
      CONFIG_KEY,
      `You are changing a timeout/deadline/retry value in ${filePath} (${described}). ` +
        'Before changing a value to fix a symptom ("X is slow/fails"), confirm you have ' +
        'the evidence that proves the cause: a log line from the failing provider/process, ' +
        "not a hypothesis. If you don't have that log line yet, get it before writing this " +
        'change — do not guess a new number. A timeout should measure inactivity, not total ' +
        'time. This is a warning, not a block — the write proceeds either way.',
    );
  },
);
