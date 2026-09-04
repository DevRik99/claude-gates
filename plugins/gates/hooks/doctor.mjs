// doctor — SessionStart hook. Validates the environment claude-gates needs and speaks
// ONLY on failure: node's version (node:sqlite and other built-ins the plugin relies on
// need >=22.5.0, read from this package's own engines.node when reachable, else a
// hard-coded fallback) and that every gate script the registry declares actually exists
// on disk (a plugin installed half — e.g. copied without a file, or a stale global
// install) fails silently otherwise: hooks.json references a script that is not there,
// and Claude Code just skips it without telling anyone).
//
// justification: no existing tool covers this. wiring-check.mjs (same family) checks
// registry vs hooks.json vs disk cross-consistency; doctor.mjs checks the runtime
// environment itself (node version) plus the same "script exists" fact from the angle
// of "can this plugin even run", so a broken environment is caught before any gate is
// invoked and blocks something for the wrong reason.
//
// Fail-safe: every check is wrapped so a doctor bug never blocks a session from
// starting — worst case it silently skips a check rather than throwing.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STDIN_FILE_DESCRIPTOR = 0;
const SESSION_START_EVENT = 'SessionStart';
const CONFIG_KEY = 'validateEnvironmentOnStart';
const DEFAULT_MIN_NODE_VERSION = '22.5.0';

const HOOKS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HOOKS_DIRECTORY, '..', '..', '..');
const PACKAGE_JSON_PATH = join(REPOSITORY_ROOT, 'package.json');
const REGISTRY_PATH = join(REPOSITORY_ROOT, 'registry.json');
const PLUGIN_MANIFEST_PATH = join(
  HOOKS_DIRECTORY,
  '..',
  '.claude-plugin',
  'plugin.json',
);
const PLUGIN_CACHE = join(homedir(), '.claude', 'plugins', 'cache');
const PLUGIN_NAME = 'gates';

// Same config lookup as the other session hooks (see session-tasks.mjs / register-requests.mjs):
// kept local and dependency-free so this plugin works standalone.
const PROJECT_ROOT_MARKERS = ['.git', '.ai'];
const PROJECT_CONFIG = join('.ai', 'config.json');
const GLOBAL_CONFIG = join('.claude', 'claude-gates', 'config.json');

const BOM_CHAR_CODE = 0xfeff;

/** Strips a UTF-8 BOM a Windows editor/tool may have written before the JSON. */
function stripBom(text) {
  return text.charCodeAt(0) === BOM_CHAR_CODE ? text.slice(1) : text;
}

function readJson(path) {
  try {
    return JSON.parse(stripBom(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function projectRootOf(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (
      PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The doctor gate config entry (project overrides global), or null. */
function doctorConfig(startDirectory) {
  const root = projectRootOf(startDirectory);
  const projectData = root ? readJson(join(root, PROJECT_CONFIG)) : null;
  const globalData = readJson(join(homedir(), GLOBAL_CONFIG));
  const layer = projectData?.gates ?? globalData?.gates ?? {};
  const entry = layer[CONFIG_KEY];
  if (typeof entry === 'boolean') return { enabled: entry };
  if (entry && typeof entry === 'object') return entry;
  return null;
}

function readPayload() {
  try {
    return JSON.parse(readFileSync(STDIN_FILE_DESCRIPTOR, 'utf8'));
  } catch {
    return {};
  }
}

const VERSION_SEGMENT_COUNT = 3; // major, minor, patch

/** Parses "22.5.0" (or "v22.5.0") into [22, 5, 0]; null when unparseable. */
function parseVersion(raw) {
  const withoutPrefix = String(raw ?? '').replace(/^v/, '');
  const segments = withoutPrefix.split('.').slice(0, VERSION_SEGMENT_COUNT);
  if (segments.length < VERSION_SEGMENT_COUNT) return null;
  const numbers = segments.map((segment) => Number(/^\d+/.exec(segment)?.[0]));
  return numbers.some((n) => Number.isNaN(n)) ? null : numbers;
}

/** True when `actual` >= `required`, comparing major.minor.patch lexicographically. */
function versionAtLeast(actual, required) {
  const a = parseVersion(actual);
  const r = parseVersion(required);
  if (!a || !r) return true; // can't parse: don't fail the session over a doctor bug
  for (let index = 0; index < VERSION_SEGMENT_COUNT; index += 1) {
    if (a[index] > r[index]) return true;
    if (a[index] < r[index]) return false;
  }
  return true;
}

/** The first "x.y.z"-shaped token inside an engines.node range string (">=22.5.0" -> "22.5.0"). */
function firstVersionToken(engineRange) {
  for (const token of engineRange.split(/\s+/)) {
    const digits = token.replace(/[^\d.]/g, '');
    if (parseVersion(digits)) return digits;
  }
  return null;
}

/** The minimum node version this install requires: package.json's engines.node, else the fallback. */
function minNodeVersionRequired(configuredMin) {
  if (configuredMin) return configuredMin;
  const packageManifest = readJson(PACKAGE_JSON_PATH);
  const engineRange = packageManifest?.engines?.node;
  const token = engineRange ? firstVersionToken(engineRange) : null;
  return token ?? DEFAULT_MIN_NODE_VERSION;
}

function directoriesIn(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** A newer gates version sitting in Claude Code's plugin cache means this session runs a
 * stale install (the marketplace still points at an old package path). */
function staleInstallProblem() {
  const running = readJson(PLUGIN_MANIFEST_PATH)?.version;
  if (!parseVersion(running)) return null;
  let newest = running;
  let marketplace = null;
  for (const marketplaceName of directoriesIn(PLUGIN_CACHE)) {
    for (const version of directoriesIn(
      join(PLUGIN_CACHE, marketplaceName, PLUGIN_NAME),
    )) {
      if (parseVersion(version) && !versionAtLeast(newest, version)) {
        newest = version;
        marketplace = marketplaceName;
      }
    }
  }
  if (newest === running) return null;
  return (
    `the gates plugin running in this session is ${running} but ${newest} is installed in the ` +
    `plugin cache (${marketplace}). Run \`claude plugin update ${PLUGIN_NAME}@${marketplace}\` or ` +
    '`claude-gates init --global --defaults --yes` from the newer package, then restart the session.'
  );
}

function checkNodeVersion(minVersion) {
  if (versionAtLeast(process.version, minVersion)) return null;
  return (
    `node ${process.version} is below the required >=${minVersion}. ` +
    'Some gates (e.g. node:sqlite-backed task tracking) will not work until node is upgraded.'
  );
}

/** Every script the registry's PreToolUse/Stop gates (folder-style: gates/<id>/index.mjs) declare. */
function missingFolderGateScripts() {
  const registry = readJson(REGISTRY_PATH);
  if (!registry?.families) return []; // can't read the registry: nothing to report

  const problems = [];
  for (const family of registry.families) {
    const pluginName = family.plugin ?? 'gates';
    const pluginHooksDirectory = join(
      REPOSITORY_ROOT,
      'plugins',
      pluginName,
      'hooks',
    );
    for (const gate of family.gates ?? []) {
      const scriptPath = join(pluginHooksDirectory, gate.script);
      if (!existsSync(scriptPath)) {
        problems.push(
          `${gate.id} (expected ${join('plugins', pluginName, 'hooks', gate.script)})`,
        );
      }
    }
  }
  return problems;
}

function speak(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: SESSION_START_EVENT,
        additionalContext: context,
      },
    }),
  );
}

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();

  const config = doctorConfig(cwd);
  if (config && config.enabled === false) return; // gate turned off for this project

  const problems = [];

  const minVersion = minNodeVersionRequired(config?.minNodeVersion);
  const versionProblem = checkNodeVersion(minVersion);
  if (versionProblem) problems.push(versionProblem);

  const staleInstall = staleInstallProblem();
  if (staleInstall) problems.push(staleInstall);

  const missingScripts = missingFolderGateScripts();
  if (missingScripts.length > 0) {
    problems.push(
      `${missingScripts.length} gate script(s) declared in registry.json are missing on disk: ${missingScripts.join(
        ', ',
      )}`,
    );
  }

  if (problems.length === 0) return; // environment is healthy: stay silent

  speak(
    `[doctor] claude-gates environment check failed:\n- ${problems.join('\n- ')}`,
  );
}

try {
  main();
} catch {
  // A doctor bug must never block session start.
}
