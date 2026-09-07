// adversarial-tests — a test file may only be written when it carries evidence that it was
// written to BREAK the implementation, not to watch it work.
//
// justification: no existing gate covers this. `test-matrix` judges a delegation PROMPT
// (which test types the requirement makes mandatory, before the work starts) and
// `test-after-implementation` judges the ORDER (a test created after its implementation
// proves nothing). Neither one ever reads what the test actually says. The gap they left is
// the common one: the agent is forced to test, writes four happy-path assertions, and every
// gate is satisfied by a suite that cannot fail.
//
// What counts as evidence is defined in lib/attack-matrix.mjs: a declared matrix row per
// category, and for every row claimed COVERED a case in the same file that names that
// attack. A declaration alone is not accepted, because a checkbox is free.
//
// Scope, and why each edge is where it is:
//   - Creating or replacing a test file is judged in full: that content IS the file.
//   - An edit is judged only when it ADDS cases, and against disk + the fragment, so that
//     ordinary maintenance (renaming, fixing an assertion) is never blocked, while growing a
//     non-compliant file cannot be used to get around the check one case at a time.
//   - An edit that REMOVES matrix rows is denied on its own: evidence that can be deleted
//     the moment it becomes inconvenient is not evidence.
//   - A shell command that writes a test path AND contains cases (a heredoc) is judged as
//     content, because otherwise `cat > x.test.mjs <<EOF` is a hole straight through this.
//     A `cp`/`mv` of a test file carries no cases and is left alone.
//
// OFF by default: the doctrine is a deliberate choice a project makes, and turning it on
// mid-flight would refuse every test file already on disk the first time it is touched.

import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import {
  DEFAULT_MIN_ADVERSARIAL_RATIO,
  DEFAULT_MIN_MUTATIONS,
  DEFAULT_REQUIRED_CATEGORIES,
  ESCAPE_HATCH,
  TEST_PATH_PATTERN,
  attackMatrixProblems,
  attackMatrixSkeleton,
  countCases,
  hasEscapeHatch,
  isTestPath,
  parseAttackMatrix,
} from '../../lib/attack-matrix.mjs';
import { projectRootOf } from '../../lib/config.mjs';
import {
  deny,
  runGate,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';
import {
  isReadOnlyCommand,
  isSelfRemedyCommand,
} from '../../lib/shell-safety.mjs';

const GATE_ID = 'adversarial-tests';
const CONFIG_KEY = 'requireAdversarialTests';

function readFileOrEmpty(path) {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

function previousFragment(toolInput) {
  if (typeof toolInput.old_string === 'string') return toolInput.old_string;
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((edit) => String(edit?.old_string ?? ''))
      .join('\n');
  }
  return '';
}

function isFragmentWrite(toolInput) {
  return (
    typeof toolInput.new_string === 'string' ||
    typeof toolInput.new_source === 'string' ||
    Array.isArray(toolInput.edits)
  );
}

function evidenceWeight(text, requiredCategories) {
  const parsed = parseAttackMatrix(text, requiredCategories);
  return parsed.rows.size + (parsed.hasHeader ? 1 : 0);
}

function optionsFrom(parameters) {
  return {
    requiredCategories: parameters.requiredCategories?.length
      ? parameters.requiredCategories
      : DEFAULT_REQUIRED_CATEGORIES,
    minMutations: parameters.minMutations,
    minAdversarialRatio: parameters.minAdversarialRatio,
  };
}

function refuse(subject, problems, options, escapeHatch) {
  const listed = problems.map((problem) => `  - ${problem}`).join('\n');
  deny(
    CONFIG_KEY,
    `${subject} does not carry checkable adversarial evidence:\n${listed}\n\n` +
      'A test suite is accepted here when it says which attacks it made and a case backs ' +
      'each claim up. Paste this block at the top of the file, fill it with the truth, and ' +
      'write the cases the rows promise:\n' +
      `${attackMatrixSkeleton(options.requiredCategories)}\n` +
      'Rows that genuinely cannot apply are "N/A — <reason>", never dropped. If this file ' +
      `is a deliberate exception, add "${escapeHatch}" to it and say why.`,
  );
}

function judgeFragment({ toolInput, written, filePath, options, escapeHatch }) {
  const subject = basename(filePath);
  const before = previousFragment(toolInput);
  if (
    evidenceWeight(before, options.requiredCategories) >
    evidenceWeight(written, options.requiredCategories)
  ) {
    refuse(
      subject,
      [
        'this edit deletes attack-matrix rows. The evidence is the only thing that makes the suite checkable, so it cannot be removed while the cases it describes stay.',
      ],
      options,
      escapeHatch,
    );
  }
  if (countCases(written) === 0) return;
  const disk = readFileOrEmpty(filePath);
  if (hasEscapeHatch(disk, escapeHatch)) return;
  const problems = attackMatrixProblems(`${disk}\n${written}`, options);
  if (problems.length > 0) refuse(subject, problems, options, escapeHatch);
}

function judgeWrite(toolInput, parameters, cwd) {
  const rawPath = writtenPathOf(toolInput);
  if (!isTestPath(rawPath, parameters.testPathPattern)) return;

  const written = writtenContentOf(toolInput);
  if (!written.trim()) return;
  const escapeHatch = parameters.escapeHatch ?? ESCAPE_HATCH;
  if (hasEscapeHatch(written, escapeHatch)) return;

  const options = optionsFrom(parameters);
  const root = projectRootOf(cwd) ?? cwd;
  const filePath = isAbsolute(rawPath) ? rawPath : join(root, rawPath);

  if (isFragmentWrite(toolInput)) {
    judgeFragment({ toolInput, written, filePath, options, escapeHatch });
    return;
  }

  const problems = attackMatrixProblems(written, options);
  if (problems.length > 0) {
    refuse(basename(filePath), problems, options, escapeHatch);
  }
}

function judgeShell(toolInput, parameters) {
  const command = shellCommandOf(toolInput);
  if (!command.trim()) return;
  if (isSelfRemedyCommand(command)) return;
  if (
    isReadOnlyCommand(command, {
      writesPaths: shellWrittenPaths(command).length > 0,
    })
  ) {
    return;
  }
  const escapeHatch = parameters.escapeHatch ?? ESCAPE_HATCH;
  if (hasEscapeHatch(command, escapeHatch)) return;
  const targets = shellWrittenPaths(command).filter((path) =>
    isTestPath(path, parameters.testPathPattern),
  );
  if (targets.length === 0 || countCases(command) === 0) return;

  const options = optionsFrom(parameters);
  const problems = attackMatrixProblems(command, options);
  if (problems.length > 0) {
    refuse(basename(targets[0]), problems, options, escapeHatch);
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      requiredCategories: [...DEFAULT_REQUIRED_CATEGORIES],
      minMutations: DEFAULT_MIN_MUTATIONS,
      minAdversarialRatio: DEFAULT_MIN_ADVERSARIAL_RATIO,
      testPathPattern: TEST_PATH_PATTERN,
      escapeHatch: ESCAPE_HATCH,
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    if (toolInGroups(toolName, ['write']))
      judgeWrite(toolInput, parameters, cwd);
    if (toolInGroups(toolName, ['shell'])) judgeShell(toolInput, parameters);
  },
);
