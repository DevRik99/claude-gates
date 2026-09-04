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

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
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
});

const KIND_EXTENSIONS = {
  agents: ['.md'],
  commands: ['.md', '.toml'],
};

function readPayload() {
  try {
    return JSON.parse(readFileSync(STDIN_FILE_DESCRIPTOR, 'utf8'));
  } catch {
    return {};
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mtimeMsOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// ── Front matter ────────────────────────────────────────────────────────────────────
// A bare block-scalar indicator (`>`, `>-`, `|`, `|-`) means the value is on the following
// indented lines; without this the blurb rendered as ">".
const BLOCK_SCALAR_INDICATOR_PATTERN = /^[|>][+-]?\d*$/;

function readBlockScalarValue(lines, startIndex) {
  const parts = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---') break;
    if (!/^[ \t]+\S/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(' ');
}

// Parsed line by line (no multi-line regex) so a large body can never backtrack.
function parseFrontMatter(fileText) {
  const lines = fileText.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: '', description: '' };
  let name = '';
  let description = '';
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---') break;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (BLOCK_SCALAR_INDICATOR_PATTERN.test(value)) {
      value = readBlockScalarValue(lines, index + 1);
    }
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
  }
  return { name, description };
}

function truncateAtWordBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;
  const budget = text.slice(0, maxChars - 1);
  const lastSpace = budget.lastIndexOf(' ');
  const cut = lastSpace > 0 ? budget.slice(0, lastSpace) : budget;
  return `${cut.trimEnd()}…`;
}

function firstClause(description, maxClauseChars) {
  if (!description) return '';
  const sentenceEnd = description.indexOf('. ');
  const clause =
    sentenceEnd > 0 ? description.slice(0, sentenceEnd) : description;
  return truncateAtWordBoundary(clause, maxClauseChars);
}

// ── Discovery ───────────────────────────────────────────────────────────────────────
function filesUnder(directory, extensions) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const full = join(directory, name);
    if (isDirectory(full)) files.push(...filesUnder(full, extensions));
    else if (extensions.includes(extname(name).toLowerCase())) files.push(full);
  }
  return files;
}

function entryFor(file, fallbackName) {
  const mtimeMs = mtimeMsOf(file);
  if (mtimeMs === null) return null;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { name, description } = parseFrontMatter(content);
  return {
    name: name || fallbackName,
    description,
    stamp: `${file}:${mtimeMs}`,
  };
}

function skillEntriesUnder(skillsRoot) {
  let names;
  try {
    names = readdirSync(skillsRoot);
  } catch {
    return [];
  }
  return names
    .filter((name) => isDirectory(join(skillsRoot, name)))
    .map((name) => entryFor(join(skillsRoot, name, 'SKILL.md'), name))
    .filter(Boolean);
}

function fileEntriesUnder(directory, extensions) {
  return filesUnder(directory, extensions)
    .map((file) => entryFor(file, basename(file, extname(file))))
    .filter(Boolean);
}

function resolveExtra(root, directory) {
  return isAbsolute(directory) ? directory : join(root, directory);
}

function skillRootsFor(root, extraDirectories) {
  return [
    join(root, '.claude', 'skills'),
    join(root, '.agents', 'skills'),
    join(root, '.ai', 'skills'),
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.ai', 'skills'),
    ...extraDirectories.map((directory) => resolveExtra(root, directory)),
  ];
}

function fileRootsFor(root, kind, extraDirectories) {
  return [
    join(root, '.claude', kind),
    join(homedir(), '.claude', kind),
    ...extraDirectories.map((directory) => resolveExtra(root, directory)),
  ];
}

function collectKind(kind, root, settings) {
  if (kind === 'skills') {
    return skillRootsFor(root, settings.extraSkillsDirs).flatMap(
      skillEntriesUnder,
    );
  }
  const extensions = KIND_EXTENSIONS[kind];
  if (!extensions) return [];
  const extra =
    kind === 'agents' ? settings.extraAgentsDirs : settings.extraCommandsDirs;
  return fileRootsFor(root, kind, extra).flatMap((directory) =>
    fileEntriesUnder(directory, extensions),
  );
}

// First occurrence wins, and project roots come first: a project capability shadows a
// global one of the same name.
function entriesForKind(kind, root, settings) {
  const seen = new Set();
  const unique = [];
  for (const entry of collectKind(kind, root, settings)) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    unique.push(entry);
  }
  return unique.sort((a, b) => a.name.localeCompare(b.name));
}

function buildRawCatalog(root, settings) {
  const catalog = {};
  for (const kind of settings.kinds) {
    const entries = entriesForKind(kind, root, settings);
    if (entries.length > 0) catalog[kind] = entries;
  }
  return catalog;
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
  return `[capabilities] available (check before improvising something one of these covers):\n${sections.join('\n')}\n`;
}

// A changed catalog (or the first message of a session) injects immediately; otherwise
// every Nth message.
function injectionDecision(session, fingerprint, injectEveryMessages) {
  const changed = session.fingerprint !== fingerprint;
  const nextCount = (Number(session.messageCount) || 0) + 1;
  const shouldInject = changed || nextCount >= injectEveryMessages;
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

function shouldInjectNow(sessionId, root, fingerprint, injectEveryMessages) {
  const session = readSessionState(GATE_ID, sessionId, {}, { cwd: root });
  const { shouldInject, messageCount } = injectionDecision(
    session,
    fingerprint,
    injectEveryMessages,
  );
  writeSessionState(
    GATE_ID,
    sessionId,
    { fingerprint, messageCount },
    { cwd: root },
  );
  return shouldInject;
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
    settings.injectEveryMessages,
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
