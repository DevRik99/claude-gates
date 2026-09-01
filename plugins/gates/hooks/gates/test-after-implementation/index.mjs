import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import {
  runGate,
  deny,
  toolInGroups,
  writtenPathOf,
  writtenContentOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'test-after-implementation';
const CONFIG_KEY = 'warnTestWrittenAfterImplementation';

// Escape hatch: a regression test written AFTER reproducing a bug is a legitimate
// test-after-implementation case (the project's own rule: reproduce the bug, then write the
// test that pins it). A deny cannot advise-and-pass, so that legitimate case needs an
// explicit opt-out — this marker anywhere in the test file's content lets it through.
const DEFAULT_ESCAPE_HATCH = 'test-after-impl:allow';

const DEFAULT_IMPLEMENTATION_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.vue',
];
const TEST_FILE_PATTERN = /\.(spec|test)\.[cm]?[jt]sx?$/i;
// `git status --porcelain` prefixes each line with a 2-character status code plus a space.
const PORCELAIN_STATUS_PREFIX_LENGTH = 3;

function baseNameWithoutTestSuffix(fileName) {
  return fileName.replace(TEST_FILE_PATTERN, '');
}

function gitStatusPorcelain(cwd) {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      timeout: 5000,
    }).toString();
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Not a git repo, or git unavailable — nothing to cross-check against.
    return [];
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      implementationExtensions: DEFAULT_IMPLEMENTATION_EXTENSIONS,
      escapeHatch: DEFAULT_ESCAPE_HATCH,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['write'])) return;

    const filePath = writtenPathOf(toolInput);
    if (!TEST_FILE_PATTERN.test(filePath)) return;
    if (existsSync(filePath)) return; // only new test file creation, not edits

    // Explicit opt-out for a legitimate regression test (bug reproduced first, then pinned).
    const escapeHatch = parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH;
    if (escapeHatch && writtenContentOf(toolInput).includes(escapeHatch))
      return;

    const cwd = process.cwd();
    const statusLines = gitStatusPorcelain(cwd);
    if (statusLines.length === 0) return;

    const testFileName = basename(filePath);
    const stem = baseNameWithoutTestSuffix(testFileName);
    // `git status --porcelain` reports paths relative to `cwd`; the test's own
    // directory (relative to `cwd`) is the fair comparison, not its absolute path.
    // `relative()` returns '' for the repo root itself, while `dirname()` on a
    // bare file name returns '.' — normalize both to '.' so root-level files compare equal.
    const testDirectoryRelativeToRepo = relative(cwd, dirname(filePath)) || '.';

    const pairedImplementationChanged = statusLines.some((line) => {
      const changedPath = line.slice(PORCELAIN_STATUS_PREFIX_LENGTH).trim();
      if (
        !parameters.implementationExtensions.some((extension) =>
          changedPath.endsWith(extension),
        )
      )
        return false;
      if (TEST_FILE_PATTERN.test(changedPath)) return false;
      const lastDot = changedPath.lastIndexOf('.');
      const changedBase = basename(
        changedPath,
        lastDot >= 0 ? changedPath.slice(lastDot) : '',
      );
      return (
        changedBase === stem &&
        (dirname(changedPath) || '.') === testDirectoryRelativeToRepo
      );
    });

    if (!pairedImplementationChanged) return;

    deny(
      CONFIG_KEY,
      `Creating test ${testFileName} after its paired implementation was already modified ` +
        '(uncommitted). Write the test before or alongside the implementation, not after — a ' +
        'test that passes the first time it runs proves nothing about the change. If this is a ' +
        'regression test for a bug you already reproduced (reproduce first, then pin it), add ' +
        `the marker "${parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH}" in the test content to allow it.`,
    );
  },
);

// Note: this restores the source guard's (guard-test-despues-de-implementar.mjs) original
// deny severity. It was warn during the config-key migration; the user's directive is that a
// gate stays warn only when the defect is genuinely invisible to a hook. Here the defect is a
// complete, git-verifiable fact, so it denies — with an escape hatch for the legitimate
// regression-test case. The config key still reads warn* for backward compatibility.
