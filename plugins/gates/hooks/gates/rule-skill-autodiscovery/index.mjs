import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'rule-skill-autodiscovery';
const CONFIG_KEY = 'autodiscoverRulesAndSkills';

const DEFAULT_RULES_DIR = 'rules';
const DEFAULT_GATE_FILE_NAMES = [
  'gate.mjs',
  'rules.mjs',
  'check.mjs',
  'verify.mjs',
];

function isGateFile(fileName, gateFileNames) {
  return gateFileNames.includes(fileName) || fileName.endsWith('.gate.mjs');
}

function findScriptsIn(scriptsDirectory, gateFileNames) {
  if (!existsSync(scriptsDirectory)) return [];
  let entries;
  try {
    entries = readdirSync(scriptsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => /\.(mjs|js)$/.test(entry.name))
    .filter((entry) => isGateFile(entry.name, gateFileNames))
    .map((entry) => join(scriptsDirectory, entry.name));
}

function discoverScripts(projectRoot, rulesDirectoryName, gateFileNames) {
  const scripts = [
    ...findScriptsIn(join(projectRoot, rulesDirectoryName), gateFileNames),
  ];

  const skillsRoot = join(projectRoot, '.claude', 'skills');
  if (existsSync(skillsRoot)) {
    let skillDirectories;
    try {
      skillDirectories = readdirSync(skillsRoot, {
        withFileTypes: true,
      }).filter((entry) => entry.isDirectory());
    } catch {
      skillDirectories = [];
    }
    for (const skillDirectory of skillDirectories) {
      scripts.push(
        ...findScriptsIn(join(skillsRoot, skillDirectory.name), gateFileNames),
      );
    }
  }

  return scripts;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: {
      rulesDir: DEFAULT_RULES_DIR,
      gateFileNames: DEFAULT_GATE_FILE_NAMES,
    },
  },
  ({ toolName, parameters }) => {
    const isExecution = TOOL_GROUPS.execution.includes(toolName);
    const isDelegation = TOOL_GROUPS.delegation.includes(toolName);
    if (!isExecution && !isDelegation) return;

    const projectRoot = process.cwd();
    const scripts = discoverScripts(
      projectRoot,
      parameters.rulesDir,
      parameters.gateFileNames,
    );
    if (scripts.length === 0) return;

    for (const script of scripts) {
      try {
        execFileSync(process.execPath, [script], {
          stdio: 'ignore',
          timeout: 5000,
        });
      } catch {
        deny(
          GATE_ID,
          `Sub-gate failed: ${relative(projectRoot, script)}. Fix it before continuing.`,
        );
        return;
      }
    }
  },
);
