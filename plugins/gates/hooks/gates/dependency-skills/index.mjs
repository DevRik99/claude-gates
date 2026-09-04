// dependency-skills — a dependency that is NEW to the project must be covered by a skill.
// Only the delta counts: a rewrite of package.json that keeps every existing dependency is
// not "adding" anything, so the gate compares what will be written (or installed from the
// shell) against the package.json already on disk. A version bump is never a new dependency.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  runGate,
  deny,
  toolInGroups,
  writtenPathOf,
  writtenContentOf,
  shellCommandOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'dependency-skills';
const CONFIG_KEY = 'requireSkillForNewDependency';
const PACKAGE_FILE = 'package.json';

const DEFAULT_DEPS_WITHOUT_OWN_API = [
  'clsx',
  'classnames',
  'lodash.debounce',
  'lodash.throttle',
  'lodash.merge',
  'tslib',
  'core-js',
  'regenerator-runtime',
];

const INSTALL_COMMANDS = [
  { manager: 'npm', verbs: ['i', 'install', 'add'] },
  { manager: 'pnpm', verbs: ['add'] },
  { manager: 'yarn', verbs: ['add'] },
  { manager: 'bun', verbs: ['add'] },
];
const REGISTRY_NAME_PATTERN = /^(?:@[\w.-]+\/)?[\w.-]+$/;
const SEGMENT_SEPARATOR = /&&|\|\||[;|\n]/;

function normalize(name) {
  return name.replace(/^@/, '').replace(/\//g, '-').toLowerCase();
}

function isExempt(dependencyName, dependenciesWithoutOwnApi) {
  if (dependencyName.startsWith('@types/')) return true;
  return dependenciesWithoutOwnApi.includes(dependencyName);
}

// statSync (not Dirent.isDirectory) so a skill installed as a junction/symlink counts.
function listSkillDirectories(skillsDirectoryPath) {
  try {
    return readdirSync(skillsDirectoryPath).filter((name) => {
      try {
        return statSync(join(skillsDirectoryPath, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// A skill covers a dependency when its normalized name equals the dependency's or contains
// it as a whole `-` segment; bidirectional substring matching let `rip` cover `stripe`.
function skillNameMatches(normalizedDependency, skillDirectoryName) {
  const normalizedSkill = normalize(skillDirectoryName);
  if (normalizedSkill === normalizedDependency) return true;
  return normalizedSkill.split('-').includes(normalizedDependency);
}

function hasMatchingSkill(dependencyName, skillDirectories) {
  const normalizedDependency = normalize(dependencyName);
  return skillDirectories.some((skillDirectoryName) =>
    skillNameMatches(normalizedDependency, skillDirectoryName),
  );
}

function dependencyNamesOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies']) {
    const block = parsed[field];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return [...names];
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readTextOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function applyEdit(base, edit) {
  const oldString = String(edit.old_string ?? '');
  const newString = String(edit.new_string ?? '');
  if (!oldString) return base || newString;
  if (edit.replace_all) return base.split(oldString).join(newString);
  const at = base.indexOf(oldString);
  if (at === -1) return base;
  return base.slice(0, at) + newString + base.slice(at + oldString.length);
}

function writtenPackageText(toolInput, diskText) {
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits.reduce(
      (text, edit) => applyEdit(text, edit ?? {}),
      diskText,
    );
  }
  if (typeof toolInput.old_string === 'string')
    return applyEdit(diskText, toolInput);
  return writtenContentOf(toolInput);
}

function packageNameOf(token) {
  const versionAt = token.indexOf('@', token.startsWith('@') ? 1 : 0);
  const name = versionAt === -1 ? token : token.slice(0, versionAt);
  return REGISTRY_NAME_PATTERN.test(name) ? name : null;
}

function installedPackagesIn(command) {
  const names = [];
  for (const segment of command.split(SEGMENT_SEPARATOR)) {
    const [manager = '', verb = '', ...rest] = segment.trim().split(/\s+/);
    const spec = INSTALL_COMMANDS.find(
      (candidate) => candidate.manager === manager.toLowerCase(),
    );
    if (!spec || !spec.verbs.includes(verb)) continue;
    for (const token of rest) {
      if (token.startsWith('-')) continue;
      const name = packageNameOf(token);
      if (name) names.push(name);
    }
  }
  return names;
}

function resolveAgainst(root, path) {
  return isAbsolute(path) ? path : join(root, path);
}

/** Dependencies the call introduces, or null when the written JSON is not parseable yet. */
function newDependenciesOf(toolName, toolInput, root) {
  if (toolInGroups(toolName, ['shell'])) {
    const names = installedPackagesIn(shellCommandOf(toolInput));
    if (names.length === 0) return [];
    const disk = dependencyNamesOf(
      parseJsonOrNull(readTextOrEmpty(join(root, PACKAGE_FILE))),
    );
    return names.filter((name) => !disk.includes(name));
  }
  if (!toolInGroups(toolName, ['write'])) return [];
  const filePath = writtenPathOf(toolInput);
  if (basename(filePath) !== PACKAGE_FILE) return [];
  const diskText = readTextOrEmpty(resolveAgainst(root, filePath));
  const written = parseJsonOrNull(writtenPackageText(toolInput, diskText));
  if (written === null) return null;
  const disk = dependencyNamesOf(parseJsonOrNull(diskText));
  return dependencyNamesOf(written).filter((name) => !disk.includes(name));
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      depsWithoutOwnApi: DEFAULT_DEPS_WITHOUT_OWN_API,
      projectSkillsDir: join('.claude', 'skills'),
    },
  },
  ({ toolName, toolInput, parameters, cwd }) => {
    const root = projectRootOf(cwd) ?? cwd;
    const newDependencies = newDependenciesOf(toolName, toolInput, root);
    if (!newDependencies || newDependencies.length === 0) return;

    const skillDirectories = listSkillDirectories(
      resolveAgainst(root, parameters.projectSkillsDir),
    );
    const unmatched = newDependencies.filter(
      (name) =>
        !isExempt(name, parameters.depsWithoutOwnApi) &&
        !hasMatchingSkill(name, skillDirectories),
    );
    if (unmatched.length === 0) return;

    deny(
      CONFIG_KEY,
      `New dependencies without a matching skill in ${parameters.projectSkillsDir}: ${unmatched.join(', ')}. ` +
        'Add a skill documenting how to use each (directory name matching or containing the ' +
        'package name), OR, if a dependency genuinely needs no skill, declare it in ' +
        '`depsWithoutOwnApi` in .ai/config.json — that is the explicit opt-out, edited in the ' +
        'same change. This blocks so an unreviewed dependency is a deliberate choice, not a default.',
    );
  },
);
