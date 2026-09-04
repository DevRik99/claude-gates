import { existsSync } from 'node:fs';
import { readJsonOrNull } from '../plugins/gates/hooks/lib/config.mjs';
import { SCOPES, configPathFor, readConfig, writeConfig } from './config.mjs';
import { defaultParametersOf } from './materialize.mjs';
import { allGates } from './registry.mjs';
import { adoptionOf } from './selection.mjs';

const ALL_TARGET = 'all';

export function resolveTargets(registry, ids) {
  const gates = allGates(registry);
  const families = new Set(registry.families.map((family) => family.id));
  const keys = new Set();
  const unknown = [];
  for (const id of ids) {
    if (id === ALL_TARGET) {
      for (const gate of gates) keys.add(gate.configKey);
      continue;
    }
    if (families.has(id)) {
      for (const gate of gates.filter((entry) => entry.family === id))
        keys.add(gate.configKey);
      continue;
    }
    const gate = gates.find(
      (entry) => entry.id === id || entry.configKey === id,
    );
    if (gate) keys.add(gate.configKey);
    else unknown.push(id);
  }
  if (unknown.length > 0)
    throw new Error(
      `Unknown gate, family or config key: ${unknown.join(', ')}. Run \`claude-gates registry --list\` to see the ids.`,
    );
  return [...keys];
}

export function enabledOf(entry, fallback) {
  if (typeof entry === 'boolean') return entry;
  if (entry && typeof entry === 'object')
    return entry.enabled === undefined ? fallback : entry.enabled !== false;
  return fallback;
}

function entryWithEnabled(gate, existing, enabled) {
  if (existing && typeof existing === 'object') return { ...existing, enabled };
  const hasParameters = Array.isArray(gate.params) && gate.params.length > 0;
  if (!hasParameters) return enabled;
  return { enabled, ...defaultParametersOf(gate) };
}

function adoptionFromGates(registry, gates) {
  const map = {};
  for (const gate of allGates(registry))
    map[gate.configKey] = enabledOf(gates[gate.configKey], gate.default);
  return adoptionOf(map);
}

export function toggleGates(path, registry, configKeys, enabled) {
  const existing = readConfig(path);
  if (existing.corrupt)
    throw new Error(`${path} exists but is not valid JSON. Fix it first.`);
  const gates = { ...(existing.data.gates ?? {}) };
  const changed = [];
  for (const gate of allGates(registry)) {
    if (!configKeys.includes(gate.configKey)) continue;
    const before = enabledOf(gates[gate.configKey], gate.default);
    gates[gate.configKey] = entryWithEnabled(
      gate,
      gates[gate.configKey],
      enabled,
    );
    if (before !== enabled) changed.push(gate.configKey);
  }
  const next = {
    ...existing.data,
    adopted: adoptionFromGates(registry, gates),
    gateVersion: registry.gateVersion,
    gates,
  };
  writeConfig(path, next);
  return { path, changed, unchanged: configKeys.length - changed.length };
}

export function defaultScopeFor(cwd) {
  if (existsSync(configPathFor(SCOPES.PROJECT, { cwd }))) return SCOPES.PROJECT;
  if (existsSync(configPathFor(SCOPES.GLOBAL))) return SCOPES.GLOBAL;
  return SCOPES.PROJECT;
}

function effectiveLayer(projectConfig, globalConfig) {
  if (projectConfig)
    return { name: SCOPES.PROJECT, gates: projectConfig.gates ?? {} };
  if (globalConfig)
    return { name: SCOPES.GLOBAL, gates: globalConfig.gates ?? {} };
  return { name: 'default', gates: {} };
}

export function statusRows(registry, { cwd = process.cwd() } = {}) {
  const projectPath = configPathFor(SCOPES.PROJECT, { cwd });
  const globalPath = configPathFor(SCOPES.GLOBAL);
  const projectConfig = readJsonOrNull(projectPath);
  const globalConfig = readJsonOrNull(globalPath);
  const layer = effectiveLayer(projectConfig, globalConfig);
  return allGates(registry).map((gate) => {
    const entry = layer.gates[gate.configKey];
    const declared = entry !== undefined;
    return {
      id: gate.id,
      configKey: gate.configKey,
      family: gate.family,
      enabled: enabledOf(entry, gate.default),
      source: declared ? layer.name : 'default',
    };
  });
}

export function renderStatus(rows, layerLabel) {
  const width = Math.max(...rows.map((row) => row.id.length));
  const lines = rows.map(
    (row) =>
      `${row.enabled ? 'on ' : 'off'}  ${row.id.padEnd(width)}  ${row.configKey}  (${row.source})`,
  );
  return `${layerLabel}\n${lines.join('\n')}`;
}
