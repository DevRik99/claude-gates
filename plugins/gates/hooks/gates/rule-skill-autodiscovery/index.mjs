// rule-skill-autodiscovery — runs the project's own sub-gates (rules/<gate file> and
// .claude/skills/*/<gate file>) on every execution/delegation call, feeding each the hook
// payload on stdin. A sub-gate denies by printing `{"permissionDecision":"deny",...}` or by
// exiting 2; a sub-gate that crashes or times out only WARNS, so one broken script cannot
// block all work. Deliberate restrictions, because a discovered script is arbitrary code:
//   - it runs only when THIS project's .ai/config.json enables the gate (a global setting
//     must never grant code execution to a freshly cloned repo);
//   - it gets a minimal environment (PATH/HOME/USERPROFILE/TEMP/TMP/SystemRoot/CLAUDE_*);
//   - all scripts share one 8 s budget;
//   - the gate config files are hashed before and after each script; any change is
//     reverted and denied, so a script cannot disable the gates that govern it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { projectRootOf, readJsonOrNull } from '../../lib/config.mjs';
import { runGate, deny, warn, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'rule-skill-autodiscovery';
const CONFIG_KEY = 'autodiscoverRulesAndSkills';

const DEFAULT_RULES_DIR = 'rules';
const DEFAULT_GATE_FILE_NAMES = [
  'gate.mjs',
  'rules.mjs',
  'check.mjs',
  'verify.mjs',
];
const TOTAL_BUDGET_MS = 8000;
const KIB = 1024;
const MAX_OUTPUT_BYTES = KIB * KIB;
const DENY_EXIT_CODE = 2;
const ALLOWED_ENVIRONMENT = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
]);
const ENVIRONMENT_PREFIX = 'CLAUDE_';
const PROJECT_CONFIG_RELATIVE_PATH = join('.ai', 'config.json');
const GLOBAL_CONFIG_PATH = join(
  homedir(),
  '.claude',
  'claude-gates',
  'config.json',
);

function projectEnablesGate(root) {
  const entry = readJsonOrNull(join(root, PROJECT_CONFIG_RELATIVE_PATH))
    ?.gates?.[CONFIG_KEY];
  return entry === true || entry?.enabled === true;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findScriptsIn(directory, gateFileNames) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.(mjs|js)$/.test(name))
    .filter(
      (name) => gateFileNames.includes(name) || name.endsWith('.gate.mjs'),
    )
    .map((name) => join(directory, name))
    .filter(isFile);
}

function discoverScripts(root, rulesDirectoryName, gateFileNames) {
  const scripts = findScriptsIn(join(root, rulesDirectoryName), gateFileNames);
  const skillsRoot = join(root, '.claude', 'skills');
  let skillNames;
  try {
    skillNames = readdirSync(skillsRoot);
  } catch {
    skillNames = [];
  }
  for (const name of skillNames) {
    const skillDirectory = join(skillsRoot, name);
    if (isDirectory(skillDirectory))
      scripts.push(...findScriptsIn(skillDirectory, gateFileNames));
  }
  return scripts;
}

function restrictedEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (ALLOWED_ENVIRONMENT.has(upper) || upper.startsWith(ENVIRONMENT_PREFIX))
      environment[key] = value;
  }
  return environment;
}

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

function revertConfigs(snapshots) {
  for (const snapshot of snapshots) {
    try {
      if (snapshot.content === null) {
        if (existsSync(snapshot.path)) unlinkSync(snapshot.path);
      } else {
        writeFileSync(snapshot.path, snapshot.content);
      }
    } catch {
      // Best-effort revert: the call is denied regardless.
    }
  }
}

function configsTampered(before) {
  const after = snapshotConfigs(before.map((snapshot) => snapshot.path));
  return before.some((snapshot, index) => snapshot.hash !== after[index].hash);
}

function runScript(script, root, rawPayload, timeoutMs) {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: root,
      input: rawPayload,
      env: restrictedEnvironment(),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error?.status ?? null,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
      message:
        error?.code === 'ETIMEDOUT'
          ? 'timed out'
          : String(error?.message ?? error),
    };
  }
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const NO_REASON = 'no reason given';

function jsonDecisionOf(parsed) {
  const specific = parsed?.hookSpecificOutput ?? {};
  return {
    decision:
      specific.permissionDecision ??
      parsed?.permissionDecision ??
      parsed?.decision,
    reason:
      specific.permissionDecisionReason ??
      parsed?.permissionDecisionReason ??
      parsed?.reason ??
      NO_REASON,
  };
}

function denialReasonOf(result) {
  const output = result.stdout.trim();
  const { decision, reason } = jsonDecisionOf(parseJsonOrNull(output));
  if (decision === 'deny' || decision === 'block') return reason;
  if (result.status === DENY_EXIT_CODE)
    return result.stderr.trim() || output || NO_REASON;
  return null;
}

function failureOf(result, scriptLabel) {
  if (result.status === 0 || result.status === DENY_EXIT_CODE) return null;
  const detail = result.stderr.trim() || result.message || 'unknown error';
  return `'${scriptLabel}' failed (exit ${result.status ?? 'none'}): ${detail}`;
}

function runDiscoveredScripts(scripts, root, rawPayload) {
  const watched = [
    join(root, PROJECT_CONFIG_RELATIVE_PATH),
    GLOBAL_CONFIG_PATH,
  ];
  const started = Date.now();
  const warnings = [];
  for (const [index, script] of scripts.entries()) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (remaining <= 0) {
      warnings.push(
        `${scripts.length - index} script(s) skipped: the ${TOTAL_BUDGET_MS} ms budget for all sub-gates was exhausted`,
      );
      break;
    }
    const label = relative(root, script);
    const before = snapshotConfigs(watched);
    const result = runScript(script, root, rawPayload, remaining);
    if (configsTampered(before)) {
      revertConfigs(before);
      deny(
        CONFIG_KEY,
        `Discovered rule/skill script ${label} attempted to modify gate security configuration (.ai/config.json or the global config). The change was reverted and the action is blocked.`,
      );
    }
    const reason = denialReasonOf(result);
    if (reason !== null)
      deny(CONFIG_KEY, `Sub-gate '${label}' denied: ${reason}`);
    const failure = failureOf(result, label);
    if (failure) warnings.push(failure);
  }
  return warnings;
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
  ({ toolName, parameters, cwd, rawPayload }) => {
    if (!toolInGroups(toolName, ['execution', 'delegation'])) return;
    const root = projectRootOf(cwd) ?? cwd;
    if (!projectEnablesGate(root)) return;

    const scripts = discoverScripts(
      root,
      parameters.rulesDir,
      parameters.gateFileNames,
    );
    if (scripts.length === 0) return;

    const warnings = runDiscoveredScripts(scripts, root, rawPayload);
    if (warnings.length === 0) return;
    warn(
      CONFIG_KEY,
      `Sub-gate(s) could not be evaluated, so they did not judge this call: ${warnings.join('; ')}. ` +
        `Fix the script (open it at the path above and address the error shown) or remove it from ${parameters.rulesDir}/ or the skill directory if it should not run as a gate.`,
    );
  },
);
