// feature-catalog — enforces the feature catalog's own invariants on a change to that
// file: at most `maxInProgress` features in_progress, and no feature moved to `done` by a
// direct write (only a review/QA process closes a feature).
//
// Decisions: the gate judges the CHANGE, not the content — the existing catalog is read
// from disk and a feature that was already `done` stays writable; only a NEW transition to
// done is denied. An Edit is applied to the disk content when its old_string is found, so
// the in_progress count covers the whole file, not the fragment. A shell redirect/copy
// onto the catalog is denied outright: its resulting content cannot be judged. An empty
// `catalogFileName` turns the gate off.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { projectRootOf, stripBom } from '../../lib/config.mjs';
import {
  runGate,
  deny,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'feature-catalog';
const CONFIG_KEY = 'requireFeatureCatalog';

const DEFAULT_CATALOG_FILE_NAME = 'feature_list.json';
const DEFAULT_MAX_IN_PROGRESS = 1;

const DONE_STATUS = 'done';
const IN_PROGRESS_STATUS = 'in_progress';
const STATUS_PATTERN = /["']?status["']?\s*:\s*["']?(done|in_progress)["']?/gi;

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function featuresOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.features)) return parsed.features;
  return null;
}

function countStatuses(text) {
  const counts = { done: 0, inProgress: 0 };
  for (const match of String(text).matchAll(STATUS_PATTERN)) {
    if (match[1].toLowerCase() === DONE_STATUS) counts.done += 1;
    else counts.inProgress += 1;
  }
  return counts;
}

function snapshotOf(text) {
  const features = featuresOf(parseJsonOrNull(text));
  if (!features) {
    const counts = countStatuses(text);
    return {
      parsed: false,
      done: null,
      doneCount: counts.done,
      inProgress: counts.inProgress,
    };
  }
  const done = new Set();
  let inProgress = 0;
  features.forEach((feature, index) => {
    const status = String(feature?.status ?? '').toLowerCase();
    if (status === DONE_STATUS)
      done.add(String(feature?.name ?? feature?.id ?? `#${index}`));
    if (status === IN_PROGRESS_STATUS) inProgress += 1;
  });
  return { parsed: true, done, doneCount: done.size, inProgress };
}

function newlyDone(before, after) {
  if (before.parsed && after.parsed)
    return [...after.done].filter((name) => !before.done.has(name));
  return after.doneCount > before.doneCount ? ['(unnamed feature)'] : [];
}

function diskContentOf(path) {
  try {
    return stripBom(readFileSync(path, 'utf8'));
  } catch {
    return '';
  }
}

function applyEdits(diskContent, toolInput) {
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
  let content = diskContent;
  for (const edit of edits) {
    const oldString = String(edit?.old_string ?? '');
    const newString = String(edit?.new_string ?? '');
    if (!oldString || !content.includes(oldString)) return null;
    content = edit?.replace_all
      ? content.replaceAll(oldString, newString)
      : content.replace(oldString, newString);
  }
  return content;
}

function isEdit(toolInput) {
  return (
    Array.isArray(toolInput.edits) ||
    typeof toolInput.old_string === 'string' ||
    typeof toolInput.new_string === 'string'
  );
}

function beforeAndAfter(toolInput, catalogPath) {
  const diskContent = diskContentOf(catalogPath);
  if (!isEdit(toolInput))
    return { before: diskContent, after: writtenContentOf(toolInput) };
  const applied = applyEdits(diskContent, toolInput);
  if (applied !== null) return { before: diskContent, after: applied };
  // The fragment cannot be placed in the file: judge it on its own, against nothing.
  return { before: '', after: writtenContentOf(toolInput) };
}

function judgeChange(before, after, catalogFileName, maxInProgress) {
  const beforeSnapshot = snapshotOf(before);
  const afterSnapshot = snapshotOf(after);

  const closed = newlyDone(beforeSnapshot, afterSnapshot);
  if (closed.length > 0) {
    deny(
      CONFIG_KEY,
      `This write moves ${closed.join(', ')} to 'status: done' in ${catalogFileName}. A feature is ` +
        'never closed by a direct write: only a review/QA subagent or a validated automated process ' +
        'may set done. Leave the previous status and let the review step close it.',
    );
  }

  if (afterSnapshot.inProgress > maxInProgress) {
    deny(
      CONFIG_KEY,
      `${catalogFileName} would have ${afterSnapshot.inProgress} features 'in_progress'; ` +
        `the maximum allowed is ${maxInProgress} (maxInProgress). Finish or park one before starting another.`,
    );
  }
}

function denyShellWrite(catalogFileName, path) {
  deny(
    CONFIG_KEY,
    `This shell command writes to the feature catalog (${path}) through a redirect/copy/move. ` +
      `Edit ${catalogFileName} with the Write/Edit tool instead, so the status transitions can be checked.`,
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      catalogFileName: DEFAULT_CATALOG_FILE_NAME,
      maxInProgress: DEFAULT_MAX_IN_PROGRESS,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    const catalogFileName = String(parameters.catalogFileName ?? '').trim();
    if (!catalogFileName) return;
    const targetsCatalog = (path) => String(path).includes(catalogFileName);

    if (toolInGroups(toolName, ['shell'])) {
      const written = shellWrittenPaths(shellCommandOf(toolInput)).find(
        targetsCatalog,
      );
      if (written) denyShellWrite(catalogFileName, written);
      return;
    }

    if (!toolInGroups(toolName, ['write'])) return;
    const target = writtenPathOf(toolInput);
    if (!targetsCatalog(target)) return;

    const root = projectRootOf(cwd) ?? cwd;
    const catalogPath = isAbsolute(target) ? target : join(root, target);
    const { before, after } = beforeAndAfter(toolInput, catalogPath);
    judgeChange(before, after, catalogFileName, parameters.maxInProgress);
  },
);
