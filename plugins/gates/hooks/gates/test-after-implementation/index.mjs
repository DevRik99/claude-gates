// test-after-implementation — creating a test whose paired implementation is already
// modified and uncommitted is denied: a test that passes the first time it runs proves
// nothing about the change. A regression test written after reproducing a bug is the
// legitimate exception, opted into with the escape-hatch marker. Only creation is judged;
// editing an existing test is maintenance. Pairing is same directory + same stem, on
// purpose narrow: a sibling __tests__/ layout is not paired (documented in the tests).

import { existsSync, readdirSync, statSync } from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
} from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import { workingTreeChanges } from '../../lib/git.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  writtenPathOf,
  writtenContentOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'test-after-implementation';
const CONFIG_KEY = 'warnTestWrittenAfterImplementation';

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
// An untracked directory is one porcelain entry; expanding it is bounded so a stray huge
// tree cannot stall the hook.
const MAX_EXPANDED_FILES = 5000;

function filesUnder(root, directory, collected) {
  let entries;
  try {
    entries = readdirSync(join(root, directory));
  } catch {
    return collected;
  }
  for (const name of entries) {
    if (collected.length >= MAX_EXPANDED_FILES) break;
    const relativePath = `${directory}${name}`;
    let isDirectory;
    try {
      isDirectory = statSync(join(root, relativePath)).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) filesUnder(root, `${relativePath}/`, collected);
    else collected.push(relativePath);
  }
  return collected;
}

function changedPaths(root) {
  const changes = workingTreeChanges(root);
  if (changes === null) return [];
  return changes.flatMap((entry) =>
    entry.path.endsWith('/') ? filesUnder(root, entry.path, []) : [entry.path],
  );
}

function normalizeDirectory(path) {
  const directory = dirname(path).replace(/\\/g, '/');
  return directory === '' || directory === '.' ? '.' : directory;
}

function isPairedImplementation(changedPath, stem, testDirectory, extensions) {
  if (!extensions.some((extension) => changedPath.endsWith(extension)))
    return false;
  if (TEST_FILE_PATTERN.test(changedPath)) return false;
  const changedStem = basename(changedPath, extname(changedPath));
  return (
    changedStem === stem && normalizeDirectory(changedPath) === testDirectory
  );
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
  ({ toolName, toolInput, parameters, cwd }) => {
    if (!toolInGroups(toolName, ['write'])) return;

    const rawPath = writtenPathOf(toolInput);
    if (!TEST_FILE_PATTERN.test(rawPath)) return;
    const root = projectRootOf(cwd) ?? cwd;
    const filePath = isAbsolute(rawPath) ? rawPath : join(root, rawPath);
    if (existsSync(filePath)) return;

    const escapeHatch = parameters.escapeHatch ?? DEFAULT_ESCAPE_HATCH;
    if (escapeHatch && writtenContentOf(toolInput).includes(escapeHatch))
      return;

    const testFileName = basename(filePath);
    const stem = testFileName.replace(TEST_FILE_PATTERN, '');
    const testDirectory = normalizeDirectory(relative(root, filePath));
    const paired = changedPaths(root).some((changedPath) =>
      isPairedImplementation(
        changedPath,
        stem,
        testDirectory,
        parameters.implementationExtensions,
      ),
    );
    if (!paired) return;

    deny(
      CONFIG_KEY,
      `Creating test ${testFileName} after its paired implementation was already modified ` +
        '(uncommitted). Write the test before or alongside the implementation, not after — a ' +
        'test that passes the first time it runs proves nothing about the change. If this is a ' +
        'regression test for a bug you already reproduced (reproduce first, then pin it), add ' +
        `the marker "${escapeHatch}" in the test content to allow it.`,
    );
  },
);
