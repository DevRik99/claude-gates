import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { matcherFor } from '../plugins/gates/hooks/lib/hook-io.mjs';
import { JSON_INDENT, REPOSITORY_ROOT } from './constants.mjs';
import { allGates } from './registry.mjs';

const DEFAULT_TIMEOUT_SECONDS = 30;
const MATCHED_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const PLUGIN_ROOT_VARIABLE = '${CLAUDE_PLUGIN_ROOT}';

export function hooksJsonPathFor(pluginName) {
  return join(REPOSITORY_ROOT, 'plugins', pluginName, 'hooks', 'hooks.json');
}

function hookEntry(script, timeoutSeconds, tools, event) {
  const entry = {
    hooks: [
      {
        type: 'command',
        command: `node "${PLUGIN_ROOT_VARIABLE}/hooks/${script}"`,
        timeout: timeoutSeconds,
      },
    ],
  };
  if (MATCHED_EVENTS.has(event)) entry.matcher = matcherFor(tools);
  return MATCHED_EVENTS.has(event)
    ? { matcher: entry.matcher, hooks: entry.hooks }
    : entry;
}

export function buildHooksManifest(registry, pluginName) {
  const hooks = {};
  const pluginGates = allGates(registry).filter(
    (gate) => gate.plugin === pluginName,
  );
  for (const gate of pluginGates) {
    const timeoutSeconds = gate.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const scripts = [
      { event: gate.event, script: gate.script, tools: gate.tools },
      ...(gate.extraScripts ?? []).map((extra) => ({
        event: extra.event,
        script: extra.script,
        tools: extra.tools ?? gate.tools,
      })),
    ];
    for (const { event, script, tools } of scripts) {
      hooks[event] ??= [];
      hooks[event].push(hookEntry(script, timeoutSeconds, tools, event));
    }
  }
  return { hooks };
}

export function pluginNamesIn(registry) {
  return [...new Set(allGates(registry).map((gate) => gate.plugin))];
}

function readManifestJson(pluginName) {
  try {
    return JSON.stringify(
      JSON.parse(readFileSync(hooksJsonPathFor(pluginName), 'utf8')),
    );
  } catch {
    return null;
  }
}

export function hooksManifestDrift(registry) {
  const drifted = [];
  for (const pluginName of pluginNamesIn(registry)) {
    const expected = JSON.stringify(buildHooksManifest(registry, pluginName));
    if (readManifestJson(pluginName) !== expected) drifted.push(pluginName);
  }
  return drifted;
}

export function writeHooksManifests(registry) {
  const written = [];
  for (const pluginName of pluginNamesIn(registry)) {
    const path = hooksJsonPathFor(pluginName);
    writeFileSync(
      path,
      `${JSON.stringify(buildHooksManifest(registry, pluginName), null, JSON_INDENT)}\n`,
      'utf8',
    );
    written.push(path);
  }
  return written;
}
