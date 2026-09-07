// wiring-check — SessionStart hook. Cross-checks registry.json, each plugin's hooks.json and
// the scripts on disk, and warns (never blocks — SessionStart cannot deny) when they
// disagree. This is the check that would have caught the session family itself being
// declared in registry.json with no script and no hooks.json wiring: three checks,
// each catching a different half of a broken install —
//
//   1. registry gate -> not wired: a gate.json entry exists but no hooks.json (of the
//      family's plugin) references its script for the declared event.
//   2. hooks.json command -> script missing: a hooks.json entry points at a script path
//      that does not exist on disk.
//   3. orphaned gate folder: a `gates/<id>/index.mjs` exists under a plugin's hooks/ dir
//      but registry.json has no gate pointing at it.
//
// Consistent (nothing to report) -> silent. Fail-safe: wrapped in try/catch, a bug here
// must never block session start.
//
// justification: no existing tool covers this. `cli/__tests__/registry-gates-consistency
// .test.mjs` checks registry-vs-disk at CI/dev time; this is the SAME class of check
// surfaced live, at session start, in an already-installed plugin where the source
// checkout (and that test) is not present.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STDIN_FILE_DESCRIPTOR = 0;
const SESSION_START_EVENT = 'SessionStart';
const CONFIG_KEY = 'checkWiringOnStart';

const HOOKS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HOOKS_DIRECTORY, '..', '..', '..');
const REGISTRY_PATH = join(REPOSITORY_ROOT, 'registry.json');
const DEFAULT_PLUGIN = 'gates';

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

/** The wiring-check gate config entry (project overrides global), or null. */
function wiringConfig(startDirectory) {
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

function pluginHooksDirectory(pluginName) {
  return join(REPOSITORY_ROOT, 'plugins', pluginName, 'hooks');
}

function pluginHooksJsonPath(pluginName) {
  return join(pluginHooksDirectory(pluginName), 'hooks.json');
}

/** Every hooks.json command string across all its events, flattened. */
function commandsIn(hooksJson) {
  if (!hooksJson?.hooks) return [];
  const commands = [];
  for (const entries of Object.values(hooksJson.hooks)) {
    for (const entry of entries ?? []) {
      for (const hook of entry?.hooks ?? []) {
        if (hook?.command) commands.push(hook.command);
      }
    }
  }
  return commands;
}

/** Whether some hooks.json command references this script's basename for this plugin. */
function scriptIsWired(commands, script) {
  // Commands look like `node "${CLAUDE_PLUGIN_ROOT}/hooks/gates/x/index.mjs"` — match on
  // the script's path-with-forward-slashes so it is independent of the wrapping command
  // shape (quoting, the node invocation, timeout, etc.).
  const needle = script.replace(/\\/g, '/');
  return commands.some((command) =>
    command.replace(/\\/g, '/').includes(needle),
  );
}

function checkRegistryVsHooksJson(registry) {
  const problems = [];
  const hooksJsonCache = new Map();

  for (const family of registry.families ?? []) {
    const pluginName = family.plugin ?? DEFAULT_PLUGIN;
    if (!hooksJsonCache.has(pluginName)) {
      hooksJsonCache.set(pluginName, readJson(pluginHooksJsonPath(pluginName)));
    }
    const hooksJson = hooksJsonCache.get(pluginName);
    const commands = commandsIn(hooksJson);

    for (const gate of family.gates ?? []) {
      const scriptPath = join(pluginHooksDirectory(pluginName), gate.script);
      if (!existsSync(scriptPath)) {
        problems.push(
          `gate "${gate.id}": script missing on disk (expected plugins/${pluginName}/hooks/${gate.script})`,
        );
        continue; // no point checking wiring for a script that isn't even there
      }
      if (!scriptIsWired(commands, gate.script)) {
        problems.push(
          `gate "${gate.id}": not wired in plugins/${pluginName}/hooks/hooks.json (${gate.event})`,
        );
      }
    }
  }
  return problems;
}

/** Gate folders (gates/<id>/index.mjs) on disk with no registry entry pointing at them. */
function orphanedGateFolders(registry) {
  const declaredScripts = new Set(
    (registry.families ?? []).flatMap((family) =>
      (family.gates ?? [])
        .filter((gate) => gate.script.startsWith('gates/'))
        .map((gate) => `${family.plugin ?? DEFAULT_PLUGIN}::${gate.script}`),
    ),
  );

  const problems = [];
  const pluginNames = new Set(
    (registry.families ?? []).map((family) => family.plugin ?? DEFAULT_PLUGIN),
  );
  for (const pluginName of pluginNames) {
    const gatesDirectory = join(pluginHooksDirectory(pluginName), 'gates');
    if (!existsSync(gatesDirectory)) continue;
    let entries;
    try {
      entries = readdirSync(gatesDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const script = `gates/${entry.name}/index.mjs`;
      const isRealGateFolder =
        entry.isDirectory() &&
        existsSync(join(gatesDirectory, entry.name, 'index.mjs'));
      if (!isRealGateFolder) continue;
      if (!declaredScripts.has(`${pluginName}::${script}`)) {
        problems.push(
          `plugins/${pluginName}/hooks/gates/${entry.name}/index.mjs has no registry entry`,
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

  const config = wiringConfig(cwd);
  if (config && config.enabled === false) return; // gate turned off for this project

  const registry = readJson(REGISTRY_PATH);
  if (!registry?.families) return; // can't read the registry: nothing to report

  const problems = [
    ...checkRegistryVsHooksJson(registry),
    ...orphanedGateFolders(registry),
  ];
  if (problems.length === 0) return; // everything consistent: stay silent

  speak(
    `[${CONFIG_KEY}] claude-gates wiring inconsistencies found:\n- ${problems.join('\n- ')}`,
  );
}

try {
  main();
} catch {
  // A wiring-check bug must never block session start.
}
