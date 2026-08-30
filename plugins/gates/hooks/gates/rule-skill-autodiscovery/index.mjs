import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { runGate, deny, toolInGroups } from '../../lib/hook-io.mjs';

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

// ── Security-surface protection ─────────────────────────────────────────────────────
// A discovered script runs with full Node privileges (no sandbox is realistically
// enforceable via execFileSync alone). The one privilege it must NEVER have is the
// power to mutate the gate configuration that governs whether it (or any other gate)
// runs at all — otherwise a discovered script can disable e.g.
// `blockDestructiveShellCommands` in the same tool call it was meant to be gated by,
// before any later gate could react. This is enforced deterministically: snapshot a
// hash of both config files (project + global) before executing, and after every
// script runs, compare. Any change is reverted immediately and the call is denied —
// regardless of whether the script itself exited 0.
const PROJECT_CONFIG_RELATIVE_PATH = join('.ai', 'config.json');

function globalConfigPath() {
  return join(homedir(), '.claude', 'claude-gates', 'config.json');
}

function securityConfigPaths(projectRoot) {
  return [
    join(projectRoot, PROJECT_CONFIG_RELATIVE_PATH),
    globalConfigPath(),
  ];
}

/** Reads raw bytes (or null if absent) and their hash, per watched config path. */
function snapshotConfigs(paths) {
  return paths.map((path) => {
    let content = null;
    try {
      if (existsSync(path)) content = readFileSync(path);
    } catch {
      content = null;
    }
    const hash = content
      ? createHash('sha256').update(content).digest('hex')
      : null;
    return { path, content, hash };
  });
}

/** Restores every watched config file to its pre-execution content, best-effort. */
function revertConfigs(snapshots) {
  for (const snapshot of snapshots) {
    try {
      if (snapshot.content === null) {
        if (existsSync(snapshot.path)) unlinkSync(snapshot.path);
      } else {
        writeFileSync(snapshot.path, snapshot.content);
      }
    } catch {
      // Best-effort revert: if this fails there is nothing more this gate can do
      // beyond having already denied the call.
    }
  }
}

/** Whether any watched config file's content changed since `before`. */
function configsTampered(before, projectRoot) {
  const after = snapshotConfigs(before.map((snapshot) => snapshot.path));
  return before.some((snapshot, index) => snapshot.hash !== after[index].hash);
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
    if (!toolInGroups(toolName, ['execution', 'delegation'])) return;

    const projectRoot = process.cwd();
    const scripts = discoverScripts(
      projectRoot,
      parameters.rulesDir,
      parameters.gateFileNames,
    );
    if (scripts.length === 0) return;

    const watchedConfigPaths = securityConfigPaths(projectRoot);

    for (const script of scripts) {
      const before = snapshotConfigs(watchedConfigPaths);

      let failed = false;
      try {
        execFileSync(process.execPath, [script], {
          stdio: 'ignore',
          timeout: 5000,
        });
      } catch {
        failed = true;
      }

      if (configsTampered(before, projectRoot)) {
        revertConfigs(before);
        deny(
          GATE_ID,
          `Discovered rule/skill script ${relative(projectRoot, script)} attempted to modify gate security configuration (.ai/config.json or the global config). The change was reverted and the action is blocked.`,
        );
        return;
      }

      if (failed) {
        deny(
          GATE_ID,
          `Sub-gate failed: ${relative(projectRoot, script)}. Fix it before continuing.`,
        );
        return;
      }
    }
  },
);
