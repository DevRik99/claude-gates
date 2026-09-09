// capability-map — UserPromptSubmit hook. Injects the REAL, current catalog of the project's
// AI capabilities (skills, agents, commands) as compact data — `name — first clause`, one
// line each, grouped by kind — and persists it to .ai/capability-map.json. The catalog IS
// the directory listing, so it is autosynced by construction. Injection is throttled
// (every Nth message, or immediately when the catalog changed), with the counter kept in
// session state so the map file is rewritten only when the catalog itself changed.
// Project roots are scanned BEFORE ~/.claude so a project skill shadows a global one.
// A description whose first clause runs long is replaced by a hand-written override from
// ~/.claude/blurb-overrides.json and <project>/<blurbOverridesFile> (project wins per key).
// `.agents/skills` and `.ai/skills` (home and project) are scanned as skill-only roots:
// other installers write there. Never blocks; any failure injects nothing.
//
// Discovery itself lives in lib/capabilities.mjs, shared with skill-first (the PreToolUse
// half that judges whether an action has a skill covering it): one catalog definition, so
// what the model is TOLD it has and what a gate CHECKS it has can never disagree.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildRawCatalog,
  firstClause,
  mtimeMsOf,
  truncateAtWordBoundary,
} from '../../lib/capabilities.mjs';
import {
  loadGateConfig,
  projectRootOf,
  readJsonOrNull,
} from '../../lib/config.mjs';
import { coerceParameters } from '../../lib/hook-io.mjs';
import {
  readSessionState,
  writeSessionState,
} from '../../lib/session-state.mjs';
import { workNatureOf } from '../../lib/signals.mjs';

const STDIN_FILE_DESCRIPTOR = 0;
const GATE_ID = 'capability-map';
const CONFIG_KEY = 'injectCapabilityMap';
const DUMP_ENV = 'CLAUDE_GATES_DUMP_DEFAULTS';
const ENABLED_BY_DEFAULT = true;
const JSON_INDENT = 2;

const DEFAULT_PARAMS = Object.freeze({
  kinds: ['skills', 'agents', 'commands'],
  maxClauseChars: 120,
  extraSkillsDirs: [],
  extraAgentsDirs: [],
  extraCommandsDirs: [],
  persist: true,
  mapFile: join('.ai', 'capability-map.json'),
  blurbOverridesFile: join('.ai', 'blurb-overrides.json'),
  injectEveryMessages: 10,
  reinjectOnWorkNatureChange: true,
});

function readPayload() {
  try {
    return JSON.parse(readFileSync(STDIN_FILE_DESCRIPTOR, 'utf8'));
  } catch {
    return {};
  }
}

// ── Blurbs, overrides and the fingerprint ───────────────────────────────────────────
function blurbOverridePathsFor(root, blurbOverridesFile) {
  return [
    join(homedir(), '.claude', 'blurb-overrides.json'),
    join(root, blurbOverridesFile),
  ];
}

function blurbOverridesFor(root, blurbOverridesFile) {
  const [globalPath, projectPath] = blurbOverridePathsFor(
    root,
    blurbOverridesFile,
  );
  const asObject = (value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...asObject(readJsonOrNull(globalPath)),
    ...asObject(readJsonOrNull(projectPath)),
  };
}

function applyBlurbs(entries, overrides, maxClauseChars) {
  return entries.map((entry) => {
    const override = overrides[entry.name];
    const blurb =
      typeof override === 'string' && override
        ? truncateAtWordBoundary(override, maxClauseChars)
        : firstClause(entry.description, maxClauseChars);
    return { name: entry.name, blurb };
  });
}

// Everything the rendered blurbs depend on: every source file's path+mtime, the override
// files (absent counts as a stable stamp), and the settings that shape a blurb.
function fingerprintOf(rawCatalog, root, settings) {
  const overrideStamps = blurbOverridePathsFor(
    root,
    settings.blurbOverridesFile,
  ).map((path) => `${path}:${mtimeMsOf(path) ?? 'absent'}`);
  const settingStamps = [
    `maxClauseChars=${settings.maxClauseChars}`,
    `kinds=${settings.kinds.join(',')}`,
    `blurbOverridesFile=${settings.blurbOverridesFile}`,
  ];
  const stamps = Object.values(rawCatalog)
    .flat()
    .map((entry) => entry.stamp)
    .concat(overrideStamps, settingStamps)
    .sort();
  return createHash('sha256').update(stamps.join('\n')).digest('hex');
}

function renderedCatalogOf(rawCatalog, root, settings) {
  const overrides = blurbOverridesFor(root, settings.blurbOverridesFile);
  return Object.fromEntries(
    Object.entries(rawCatalog).map(([kind, entries]) => [
      kind,
      applyBlurbs(entries, overrides, settings.maxClauseChars),
    ]),
  );
}

// ── Persistence ─────────────────────────────────────────────────────────────────────
function readPersistedMap(mapPath) {
  const data = readJsonOrNull(mapPath);
  const catalog =
    data?.capabilities && typeof data.capabilities === 'object'
      ? data.capabilities
      : null;
  const fingerprint =
    typeof data?.fingerprint === 'string' ? data.fingerprint : null;
  return { catalog, fingerprint };
}

function persistMap(mapPath, catalog, fingerprint) {
  const payload = {
    generatedAt: new Date().toISOString(),
    fingerprint,
    capabilities: catalog,
  };
  try {
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(
      mapPath,
      `${JSON.stringify(payload, null, JSON_INDENT)}\n`,
      'utf8',
    );
  } catch {
    // The injection is the job; the file is a convenience.
  }
}

function renderCatalog(catalog, kinds) {
  const sections = [];
  for (const kind of kinds) {
    const entries = catalog[kind];
    if (!entries) continue;
    const lines = entries.map((entry) =>
      entry.blurb ? `  ${entry.name} — ${entry.blurb}` : `  ${entry.name}`,
    );
    sections.push(`${kind}:\n${lines.join('\n')}`);
  }
  return `[${CONFIG_KEY}] available capabilities (check before improvising something one of these covers):\n${sections.join('\n')}\n`;
}

// Three reasons to inject, then the throttle. The catalog changing on disk was the only
// content-driven trigger the gate had, which left the case the reminder is actually for:
// the session PIVOTING to a different kind of work (debugging → designing → releasing)
// with a catalog that never moved, so the model kept whatever the throttle last emitted
// and the skills that matter for the new nature were never re-surfaced. The nature is a
// coarse lexical read of the prompt (lib/signals.mjs), and being wrong costs one extra
// injection of a never-blocking catalog — cheap enough to prefer over staying silent.
// Because a varied session changes nature nearly every turn, the pivot rule alone amounted
// to "inject always" and made the 10-message throttle decorative. A pivot now waits for the
// catalog to have gone quiet: ~300 tokens on every prompt is a real cost, and repeating the
// same list two messages apart buys nothing.
const PIVOT_QUIET_MESSAGES = 2;

function injectionDecision(session, fingerprint, nature, settings) {
  const changed = session.fingerprint !== fingerprint;
  const nextCount = (Number(session.messageCount) || 0) + 1;
  const pivoted =
    settings.reinjectOnWorkNatureChange &&
    session.workNature !== nature &&
    nextCount >= PIVOT_QUIET_MESSAGES;
  const shouldInject =
    changed || pivoted || nextCount >= settings.injectEveryMessages;
  return { shouldInject, messageCount: shouldInject ? 0 : nextCount };
}

function settingsFor(cwd) {
  const config = loadGateConfig(cwd);
  if (!config.isEnabled(CONFIG_KEY, ENABLED_BY_DEFAULT)) return null;
  const { parameters } = coerceParameters(
    DEFAULT_PARAMS,
    config.paramsFor(CONFIG_KEY),
  );
  return {
    ...parameters,
    kinds: parameters.kinds.map(String),
    maxClauseChars:
      parameters.maxClauseChars > 0
        ? parameters.maxClauseChars
        : DEFAULT_PARAMS.maxClauseChars,
    injectEveryMessages:
      parameters.injectEveryMessages > 0
        ? parameters.injectEveryMessages
        : DEFAULT_PARAMS.injectEveryMessages,
  };
}

function dumpDefaults() {
  process.stdout.write(
    JSON.stringify({
      id: GATE_ID,
      configKey: CONFIG_KEY,
      enabledByDefault: ENABLED_BY_DEFAULT,
      defaultParams: DEFAULT_PARAMS,
    }),
  );
}

function cwdOf(payload) {
  return typeof payload.cwd === 'string' && payload.cwd
    ? payload.cwd
    : process.cwd();
}

// The persisted rendering is reused only when its fingerprint matches; the map file is
// rewritten only when the rendered catalog actually differs from what is on disk.
function syncMap(mapPath, rawCatalog, fingerprint, root, settings) {
  const persisted = readPersistedMap(mapPath);
  const catalog =
    persisted.fingerprint === fingerprint && persisted.catalog
      ? persisted.catalog
      : renderedCatalogOf(rawCatalog, root, settings);
  const changed =
    persisted.fingerprint !== fingerprint ||
    JSON.stringify(persisted.catalog) !== JSON.stringify(catalog);
  if (settings.persist && changed) persistMap(mapPath, catalog, fingerprint);
  return catalog;
}

function shouldInjectNow(sessionId, root, fingerprint, nature, settings) {
  const session = readSessionState(GATE_ID, sessionId, {}, { cwd: root });
  const { shouldInject, messageCount } = injectionDecision(
    session,
    fingerprint,
    nature,
    settings,
  );
  writeSessionState(
    GATE_ID,
    sessionId,
    { fingerprint, messageCount, workNature: nature },
    { cwd: root },
  );
  return shouldInject;
}

function promptOf(payload) {
  const prompt = payload?.prompt ?? payload?.user_prompt ?? payload?.message;
  return typeof prompt === 'string' ? prompt : '';
}

function run() {
  const payload = readPayload();
  const cwd = cwdOf(payload);
  const settings = settingsFor(cwd);
  if (!settings) return;
  const root = projectRootOf(cwd) ?? cwd;

  const rawCatalog = buildRawCatalog(root, settings);
  if (Object.keys(rawCatalog).length === 0) return;

  const fingerprint = fingerprintOf(rawCatalog, root, settings);
  const catalog = syncMap(
    join(root, settings.mapFile),
    rawCatalog,
    fingerprint,
    root,
    settings,
  );
  const inject = shouldInjectNow(
    payload.session_id ?? null,
    root,
    fingerprint,
    workNatureOf(promptOf(payload)),
    settings,
  );
  if (inject) process.stdout.write(renderCatalog(catalog, settings.kinds));
}

function main() {
  if (process.env[DUMP_ENV]) {
    dumpDefaults();
    return;
  }
  try {
    run();
  } catch {
    // Context injection is best-effort; an error must never reach the user.
  }
}

main();
