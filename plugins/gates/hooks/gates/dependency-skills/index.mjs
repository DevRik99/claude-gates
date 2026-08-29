import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runGate, warn, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'dependency-skills';
const CONFIG_KEY = 'requireSkillForNewDependency';

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

function normalize(name) {
  return name.replace(/^@/, '').replace(/\//g, '-').toLowerCase();
}

function isExempt(dependencyName, dependenciesWithoutOwnApi) {
  if (dependencyName.startsWith('@types/')) return true;
  return dependenciesWithoutOwnApi.includes(dependencyName);
}

function listSkillDirectories(skillsDirectoryPath) {
  try {
    return readdirSync(skillsDirectoryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No skills directory in this project — nothing to cross-check against.
    return [];
  }
}

function skillNameMatches(normalizedDependency, skillDirectoryName) {
  const normalizedSkill = normalize(skillDirectoryName);
  return (
    normalizedDependency.includes(normalizedSkill) ||
    normalizedSkill.includes(normalizedDependency)
  );
}

function hasMatchingSkill(dependencyName, skillDirectories) {
  const normalizedDependency = normalize(dependencyName);
  return skillDirectories.some((skillDirectoryName) =>
    skillNameMatches(normalizedDependency, skillDirectoryName),
  );
}

function needsSkillReview(dependencyName, parameters, skillDirectories) {
  if (isExempt(dependencyName, parameters.depsWithoutOwnApi)) return false;
  return !hasMatchingSkill(dependencyName, skillDirectories);
}

/** Parsed `package.json` dependency names, or null when it cannot be read yet. */
function dependencyNamesIn(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Mid-edit or partially written package.json — nothing reliable to check yet.
    return null;
  }
  const dependencies = {
    ...(parsed.dependencies ?? {}),
    ...(parsed.devDependencies ?? {}),
  };
  return Object.keys(dependencies);
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      depsWithoutOwnApi: DEFAULT_DEPS_WITHOUT_OWN_API,
      projectSkillsDir: '.claude/skills',
    },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!TOOL_GROUPS.write.includes(toolName)) return;

    const filePath = toolInput?.file_path ?? '';
    if (!filePath.replace(/\\/g, '/').endsWith('package.json')) return;

    const content = toolInput?.content ?? toolInput?.new_string;
    if (typeof content !== 'string') return;

    const dependencyNames = dependencyNamesIn(content);
    if (!dependencyNames || dependencyNames.length === 0) return;

    const skillDirectories = listSkillDirectories(
      join(process.cwd(), parameters.projectSkillsDir),
    );

    const unmatched = dependencyNames.filter((name) =>
      needsSkillReview(name, parameters, skillDirectories),
    );
    if (unmatched.length === 0) return;

    warn(
      GATE_ID,
      `New dependencies without a matching skill in ${parameters.projectSkillsDir}: ${unmatched.join(', ')}. Consider adding a skill documenting how to use them, or add them to depsWithoutOwnApi if they need none.`,
    );
  },
);

// Deliberately simplified vs. the source guard (guard-dependencies-skills.mjs):
// dropped the hardcoded alias table (stripe -> stripe-payments, etc.) and the
// .ai/skills-baseline.json freeze mechanism — that belongs to a separate
// adopt-stack-and-skills.mjs script that does not exist in this repo. This
// gate only does simple substring matching between dependency name and skill
// directory name, both normalized.
