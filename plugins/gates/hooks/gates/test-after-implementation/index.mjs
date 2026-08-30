import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import { runGate, warn, toolInGroups, writtenPathOf } from '../../lib/hook-io.mjs';

const GATE_ID = 'test-after-implementation';
const CONFIG_KEY = 'warnTestWrittenAfterImplementation';

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
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['write'])) return;

    const filePath = writtenPathOf(toolInput);
    if (!TEST_FILE_PATTERN.test(filePath)) return;
    if (existsSync(filePath)) return; // only new test file creation, not edits

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

    warn(
      GATE_ID,
      `Creating test ${testFileName} after its paired implementation was already modified (uncommitted). Consider writing tests before or alongside the implementation, not after.`,
    );
  },
);

// Note: the source guard (guard-test-despues-de-implementar.mjs) denies this
// case outright. This gate warns instead, because registry.json names the
// config key warnTestWrittenAfterImplementation, which declares warn as the
// intended severity for this migration.
