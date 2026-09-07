// tests-check.mjs — runs the adversarial-evidence check over files already on disk.
//
// justification: the gate answers "may this be written", once, at the moment of writing. It
// cannot answer "is what we have compliant" for a repository that was there first, and a
// check nobody can re-run is not evidence — it is a memory of a decision. Same judge
// (lib/attack-matrix.mjs), so a file the gate would refuse is a file this reports, and CI
// can hold the line without the harness being installed at all.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  attackMatrixProblems,
  hasEscapeHatch,
  isTestPath,
} from '../plugins/gates/hooks/lib/attack-matrix.mjs';

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
]);

function walk(root, collected) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full, collected);
    } else if (isTestPath(full)) {
      collected.push(full);
    }
  }
  return collected;
}

function filesUnder(target) {
  try {
    if (statSync(target).isDirectory()) return walk(target, []);
  } catch {
    return [];
  }
  return isTestPath(target) ? [target] : [];
}

/**
 * One verdict per test file found under `targets`: `exempt` when the file carries the escape
 * hatch, `ok` when it has nothing to answer for, `problems` otherwise. A path that names no
 * test file yields nothing rather than an error, so a wide sweep never fails on a stray arg.
 */
export function checkTestFiles(targets, { cwd = process.cwd() } = {}) {
  const seen = new Set();
  const results = [];
  for (const target of targets.length > 0 ? targets : ['.']) {
    for (const file of filesUnder(
      isAbsolute(target) ? target : join(cwd, target),
    )) {
      if (seen.has(file)) continue;
      seen.add(file);
      let content;
      try {
        content = readFileSync(file, 'utf8');
      } catch (error) {
        results.push({
          file: relative(cwd, file),
          problems: [`unreadable: ${error.message}`],
        });
        continue;
      }
      const exempt = hasEscapeHatch(content);
      results.push({
        file: relative(cwd, file),
        exempt,
        problems: exempt ? [] : attackMatrixProblems(content),
      });
    }
  }
  return results;
}

export function renderTestsCheck(results) {
  const failing = results.filter((result) => result.problems.length > 0);
  const lines = [];
  for (const result of failing) {
    lines.push(`FAIL  ${result.file}`);
    for (const problem of result.problems) lines.push(`        ${problem}`);
  }
  const exempt = results.filter((result) => result.exempt).length;
  const exemptNote = exempt > 0 ? `, ${exempt} exempt` : '';
  lines.push(
    `${results.length} test file(s) checked, ${failing.length} without adversarial evidence${exemptNote}`,
  );
  return `${lines.join('\n')}\n`;
}
