// capability-map — UserPromptSubmit hook. Surfaces the REAL, current catalog of the project's
// AI capabilities — skills, agents/subagents, and commands — as compact data ("caveman"
// format: `name — first clause`, one line each, grouped by kind). It also PERSISTS that
// catalog to .ai/capability-map.json so the map is easy to follow and read the same way the
// tool map (.ai/tool-map.json) is, and so another tool or a human can consult it without
// re-scanning. Autosynced by construction: add or remove a skill/agent/command file and the
// next message reflects it (a removed capability's entry disappears with it — the catalog is
// derived from what is on disk NOW, never a stale copy of what used to be there), because the
// catalog IS the directory listing. Re-deriving blurbs (the only non-trivial per-entry work)
// is skipped when disk is provably unchanged since the last scan — see fingerprintOf below.
//
// It does NOT tell the model to obey a reminder — that would be prose the model may ignore,
// the exact antipattern guard-no-model-reliance forbids. It injects a fact (which capabilities
// exist) and lets the assistant decide to use them.
//
// justification: no existing gate covers this. rule-skill-autodiscovery EXECUTES sub-gate
// scripts found under skills; dependency-skills cross-checks package.json deps against skill
// dirs; tool-map records built TOOLS (scripts) into .ai/tool-map.json. None enumerate the
// skill/agent/command catalog or inject it as context. This is the read+inject counterpart to
// tool-map for the capability catalog.
//
// A UserPromptSubmit hook's stdout is appended to the assistant's context as plain text, so
// the catalog is simply written to stdout (no PreToolUse JSON shape). Self-contained: Node
// built-ins only.
//
// ── What it discovers (every root: ~/.claude and <project>/.claude, plus config extras) ──
//   skills    <root>/skills/<name>/SKILL.md   front matter name + description
//   agents    <root>/agents/*.md              front matter name (falls back to file basename)
//                                             + description; subagents nested deeper too
//   commands  <root>/commands/*.{md,toml}     front matter description; name is the basename
// Each injected line is `name — first clause` (up to the first '. ' or a hard char cap), so
// the whole catalog stays cheap even at dozens of entries.
//
// ── Blurb overrides for descriptions that don't fit ─────────────────────────────────────
// When a description's first clause is longer than `maxClauseChars`, mechanical truncation
// (even at a word boundary) loses the point of a dense one-liner (e.g. "Referencia normativa
// completa de accesibilidad web (WCAG 2.2, ARIA, teclado, lectores de…" tells you nothing).
// Writing an actual summary needs judgment a Node hook does not have — so instead this gate
// reads a human/assistant-authored override by capability name from `~/.claude/blurb-
// overrides.json` and `<project>/<blurbOverridesFile>` (project wins per-key) and uses it
// verbatim (still capped at maxClauseChars, in case an override itself runs long). A
// capability with no override falls back to the mechanical truncation — never blocked on
// someone writing every override up front.
//
// ── Throttled injection, not every message ──────────────────────────────────────────────
// Injecting the full catalog on every UserPromptSubmit burns context on every turn for a
// catalog that rarely changes turn-to-turn. `injectEveryMessages` (default 10, same shape as
// tasks' remindEveryMessages) counts messages via a small persisted counter next to the map
// file and only injects on the Nth. The persisted .ai/capability-map.json is still refreshed
// from disk on EVERY message regardless of the counter — persistence is cheap (a file write,
// not context) and staying accurate matters even between injections.
//
// ── Skills also scanned outside the .claude layout, unconditionally ────────────────────
// `~/.agents/skills`, `<project>/.agents/skills`, `~/.ai/skills`, `<project>/.ai/skills` are
// scanned as skill roots by default (no config needed) alongside `.claude/skills` — these
// are skill directories other installers are known to use (`.agents/skills` is what the
// `skills` CLI several installers shell out to writes when run without its `-g` flag: a
// project-local skill tree, not `~/.claude`). Agents/commands are NOT looked for under these
// roots — only `.claude` is known to lay those out as siblings of `skills`.
//
// ── What a project can configure (params) — everything is customizable ───────────────
//   kinds              which capability kinds to include, e.g. ["skills","agents","commands"].
//                      Drop one to stop scanning it entirely.
//   maxClauseChars     hard cap on each entry's one-line blurb (default 120).
//   extraSkillsDirs / extraAgentsDirs / extraCommandsDirs   additional roots per kind
//                      (relative to project or absolute), added on top of the built-in ones.
//   persist            whether to write .ai/capability-map.json (default true).
//   mapFile            path to the persisted map, relative to project root. Default
//                      .ai/capability-map.json.
//   injectEveryMessages   inject the rendered catalog only every Nth message (default 10);
//                      the persisted map file still refreshes every message regardless.
//   blurbOverridesFile   path to the overrides JSON, relative to project root. Default
//                      .ai/blurb-overrides.json.
//
// ── Fail-safe shape ──────────────────────────────────────────────────────────────────
// Nothing found anywhere, gate disabled, or unreadable input: inject nothing (silent, no
// wasted context) — and never write an empty map over a good one. Persistence failure is
// swallowed: the injection is the job, the file is a convenience. Never blocks —
// UserPromptSubmit cannot deny; it only adds context.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';

const STDIN_FILE_DESCRIPTOR = 0;
const CONFIG_KEY = 'injectCapabilityMap';
const DUMP_ENV = 'CLAUDE_GATES_DUMP_DEFAULTS';
// The registry default this gate is shipped with. Kept here (not only in dumpDefaults) so
// main() and dumpDefaults agree by construction — a value duplicated in two places is
// exactly the desync that let a gate silently miss its own registry default before (see
// the project's default-desync incident: registry.json and the gate's own hardcoded
// enabledByDefault drifting apart across a version bump).
const ENABLED_BY_DEFAULT = true;
const DEFAULT_MAX_CLAUSE_CHARS = 120;
const DEFAULT_KINDS = ['skills', 'agents', 'commands'];
const DEFAULT_MAP_FILE = join('.ai', 'capability-map.json');
const DEFAULT_BLURB_OVERRIDES_FILE = join('.ai', 'blurb-overrides.json');
const DEFAULT_INJECT_EVERY_MESSAGES = 10;
const JSON_INDENT = 2;

// Config lookup mirrors config.mjs (project → global), kept local so a gate stays runnable on
// its own alongside the other event-scripts (doctor, wiring-check).
const PROJECT_ROOT_MARKERS = ['.git', '.ai'];
const PROJECT_CONFIG = join('.ai', 'config.json');
const GLOBAL_CONFIG = join('.claude', 'claude-gates', 'config.json');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
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

/** The capability-map gate config entry (project overrides global). `enabled` is `true`/
 * `false` only when a project or global config explicitly declared it — absent (undefined)
 * means "nothing was declared, fall back to the registry default", the same three-state
 * shape config.mjs's isGateEnabled uses for every other gate. Distinguishing "never
 * declared" from "explicitly false" matters once ENABLED_BY_DEFAULT is true: without it, a
 * project that never touched this gate's config would look identical to one that turned it
 * off, and the registry default could never take effect. */
function gateConfig(startDirectory) {
  const root = projectRootOf(startDirectory);
  const projectData = root ? readJson(join(root, PROJECT_CONFIG)) : null;
  const globalData = readJson(join(homedir(), GLOBAL_CONFIG));
  const layer = projectData?.gates ?? globalData?.gates ?? {};
  const entry = layer[CONFIG_KEY];
  if (typeof entry === 'boolean') return { enabled: entry };
  if (entry && typeof entry === 'object') return entry;
  return {};
}

function readPayload() {
  try {
    return JSON.parse(readFileSync(STDIN_FILE_DESCRIPTOR, 'utf8'));
  } catch {
    return {};
  }
}

// A YAML folded/literal block scalar indicator with nothing else on the line
// (`description: >`, `description: >-`, `description: |`, `description: |-`): the real
// value is every following indented line, not this one. Seen across `.agents/skills`
// SKILL.md files (e.g. api-architect, babysit, branch-pr) — without this, the parser took
// the bare indicator itself as the description, rendering blurbs like `">"` or `">-"`.
const BLOCK_SCALAR_INDICATOR_PATTERN = /^[|>][+-]?\d*$/;

/** Every following line indented relative to the block's own indentation, joined with a
 * single space (folded-scalar semantics — good enough for a one-line blurb; literal `|`
 * blocks are folded too, which only affects a display detail this gate strips anyway via
 * firstClause). Stops at the first line that is blank or not indented (front matter end,
 * or a sibling key). */
function readBlockScalarValue(lines, startIndex) {
  const parts = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---') break;
    if (!/^[ \t]+\S/.test(line)) break; // not indented: block scalar ended
    parts.push(line.trim());
  }
  return parts.join(' ');
}

/**
 * The `name` and `description` from a markdown-style front matter block (skills, agents,
 * commands all use `---`-fenced YAML-ish front matter). Parsed line-by-line (no multi-line
 * regex) so a large file body can never trigger catastrophic backtracking. Handles a plain
 * scalar value on the `key:` line itself, and a YAML folded/literal block scalar (`>`, `>-`,
 * `|`, `|-`) whose value lives on the following indented lines. Returns { name, description }
 * with either possibly ''.
 */
function parseFrontMatter(fileText) {
  const lines = fileText.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: '', description: '' };

  let name = '';
  let description = '';
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---') break; // end of front matter
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, ''); // toml/yaml quoting around the value
    if (BLOCK_SCALAR_INDICATOR_PATTERN.test(value)) {
      value = readBlockScalarValue(lines, index + 1);
    }
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
  }
  return { name, description };
}

/** Truncates text to at most maxChars, breaking at the last whitespace boundary before
 * the limit rather than mid-word — a hard char-index cut turns "lectores de pantalla"
 * into "lectores de…", losing the word instead of just the tail of the sentence. Falls
 * back to a hard cut only when there is no whitespace to break on (one very long word). */
function truncateAtWordBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;
  const budget = text.slice(0, maxChars - 1);
  const lastSpace = budget.lastIndexOf(' ');
  const cut = lastSpace > 0 ? budget.slice(0, lastSpace) : budget;
  return `${cut.trimEnd()}…`;
}

/** The description's first clause, capped — the caveman blurb. */
function firstClause(description, maxClauseChars) {
  if (!description) return '';
  const sentenceEnd = description.indexOf('. ');
  const clause =
    sentenceEnd > 0 ? description.slice(0, sentenceEnd) : description;
  return truncateAtWordBoundary(clause, maxClauseChars);
}

/** Recursively lists files under a directory whose extension is in `extensions`. */
function filesUnder(directory, extensions) {
  if (!existsSync(directory)) return [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(full, extensions));
    } else if (extensions.includes(extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

/** The file's mtime in ms, or null when it cannot be stat'd (broken junction, race). A
 * source this gate cannot stat contributes nothing stable to the fingerprint — treated as
 * absent so a dangling link does not poison every future comparison with a NaN/undefined. */
function mtimeMsOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Skill capabilities under one root: <root>/skills/<name>/SKILL.md. Each entry carries
 * `stamp: "<path>:<mtimeMs>"`, the unit the disk fingerprint is built from (see
 * fingerprintOf) — cheap because it reuses the stat already needed to read the file, no
 * second filesystem pass. */
function skillEntriesUnder(skillsRoot, maxClauseChars) {
  if (!existsSync(skillsRoot)) return [];
  let skillDirectories;
  try {
    skillDirectories = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries = [];
  for (const skillDirectory of skillDirectories) {
    if (!skillDirectory.isDirectory()) continue;
    const skillFile = join(skillsRoot, skillDirectory.name, 'SKILL.md');
    const mtimeMs = mtimeMsOf(skillFile);
    if (mtimeMs === null) continue; // missing or a dangling link: not a real source
    let content;
    try {
      content = readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const { name, description } = parseFrontMatter(content);
    entries.push({
      name: name || skillDirectory.name,
      description,
      maxClauseChars,
      stamp: `${skillFile}:${mtimeMs}`,
    });
  }
  return entries;
}

/** Agent/command capabilities: flat or nested files whose front matter carries a description.
 * Same stamp shape as skillEntriesUnder, for the same reason. */
function fileEntriesUnder(directory, extensions, maxClauseChars) {
  const entries = [];
  for (const file of filesUnder(directory, extensions)) {
    const mtimeMs = mtimeMsOf(file);
    if (mtimeMs === null) continue;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { name, description } = parseFrontMatter(content);
    entries.push({
      name: name || basename(file, extname(file)),
      description,
      maxClauseChars,
      stamp: `${file}:${mtimeMs}`,
    });
  }
  return entries;
}

function baseRoots(cwd) {
  return [join(homedir(), '.claude'), join(cwd, '.claude')];
}

// Skill directories seen in the wild outside the `.claude/skills` layout: the `skills`
// upstream CLI (invoked by installers like caveman) writes to a project-local
// `./.agents/skills` when run without its `-g` flag (see caveman/bin/install.js's own
// comment on issue #836 — the exact bug that produced 65 dangling junctions under
// `~/.claude/skills` in one real incident: they pointed at a `.agents/skills` that only
// ever existed relative to the project the installer ran from). `.ai/skills` is included
// per explicit user instruction, without independent verification of a specific installer
// using it — kept here rather than as a project-declared default so every project gets it
// without having to know the installer's quirk. These are SKILL roots only (the directory
// IS the skills folder, unlike `.claude` where `skills/agents/commands` are siblings under
// one root) — they never gain agents/commands lookup, which would be inventing a layout
// this repo has no evidence for.
function defaultSkillOnlyRoots(cwd) {
  return [
    join(homedir(), '.agents', 'skills'),
    join(cwd, '.agents', 'skills'),
    join(homedir(), '.ai', 'skills'),
    join(cwd, '.ai', 'skills'),
  ];
}

function resolveExtra(cwd, directory) {
  return isAbsolute(directory) ? directory : join(cwd, directory);
}

/** Every entry for one kind across all roots, de-duplicated by name (each entry still
 * carries description/maxClauseChars/stamp — blurb overrides and truncation are applied
 * later, once, in applyBlurbs, not per-root). */
function entriesForKind(kind, cwd, config, maxClauseChars) {
  const perKind = {
    skills: {
      subdir: 'skills',
      extra: config.extraSkillsDirs,
      collect: (root) =>
        skillEntriesUnder(join(root, 'skills'), maxClauseChars),
      collectExtra: (directory) => skillEntriesUnder(directory, maxClauseChars),
    },
    agents: {
      extra: config.extraAgentsDirs,
      collect: (root) =>
        fileEntriesUnder(join(root, 'agents'), ['.md'], maxClauseChars),
      collectExtra: (directory) =>
        fileEntriesUnder(directory, ['.md'], maxClauseChars),
    },
    commands: {
      extra: config.extraCommandsDirs,
      collect: (root) =>
        fileEntriesUnder(
          join(root, 'commands'),
          ['.md', '.toml'],
          maxClauseChars,
        ),
      collectExtra: (directory) =>
        fileEntriesUnder(directory, ['.md', '.toml'], maxClauseChars),
    },
  }[kind];
  if (!perKind) return [];

  const collected = [];
  for (const root of baseRoots(cwd)) collected.push(...perKind.collect(root));
  if (kind === 'skills') {
    for (const root of defaultSkillOnlyRoots(cwd)) {
      collected.push(...skillEntriesUnder(root, maxClauseChars));
    }
  }
  const extra = Array.isArray(perKind.extra) ? perKind.extra : [];
  for (const directory of extra) {
    collected.push(...perKind.collectExtra(resolveExtra(cwd, directory)));
  }

  const seen = new Set();
  const unique = [];
  for (const entry of collected) {
    if (seen.has(entry.name)) continue; // a capability present in two roots is listed once
    seen.add(entry.name);
    unique.push(entry);
  }
  unique.sort((a, b) => a.name.localeCompare(b.name));
  return unique;
}

/** The two override file paths in effect for this cwd (global always; project only when a
 * project root is found), regardless of whether either currently exists. Shared by
 * blurbOverridesFor (reads them) and blurbOverrideStampsFor (fingerprints them) so the two
 * can never drift to different paths. */
function blurbOverridePathsFor(cwd, blurbOverridesFile) {
  const globalPath = join(homedir(), '.claude', 'blurb-overrides.json');
  const root = projectRootOf(cwd);
  const projectPath = root ? join(root, blurbOverridesFile) : null;
  return projectPath ? [globalPath, projectPath] : [globalPath];
}

/** The overrides map (capability name -> hand-written blurb). Project file wins over the
 * global one entry-by-entry (spread, global first) so a project can override a single
 * global entry without having to repeat the rest. */
function blurbOverridesFor(cwd, blurbOverridesFile) {
  const [globalPath, projectPath] = blurbOverridePathsFor(
    cwd,
    blurbOverridesFile,
  );
  return {
    ...(readJson(globalPath) ?? {}),
    ...(projectPath ? (readJson(projectPath) ?? {}) : {}),
  };
}

/** Stamps for the override file(s) themselves, in the same "<path>:<mtimeMs>" shape as a
 * capability's stamp — folded into the fingerprint so EDITING AN OVERRIDE (with no skill
 * file touched at all) still invalidates the cached catalog. Without this, a fresh or
 * changed blurb-overrides.json would sit unused: the persisted catalog's fingerprint would
 * still match (no skill/agent/command changed) and resolveCatalog would keep serving the
 * stale, un-overridden blurb forever — the exact bug a real run surfaced (clean-architecture
 * got an override added to blurb-overrides.json after the map had already been generated
 * once, and kept showing the mechanically-truncated text on every later run because nothing
 * ever invalidated the cache). A missing override file contributes a stable "absent" stamp
 * (not skipped) so going from absent -> present is itself a fingerprint change. */
function blurbOverrideStampsFor(cwd, blurbOverridesFile) {
  return blurbOverridePathsFor(cwd, blurbOverridesFile).map((path) => {
    const mtimeMs = mtimeMsOf(path);
    return `${path}:${mtimeMs === null ? 'absent' : mtimeMs}`;
  });
}

/** Turns a raw entry (description/maxClauseChars/stamp) into the rendered shape
 * (name/blurb/stamp) — an override is used verbatim (still capped, in case it runs long
 * itself); with no override, falls back to the mechanical first-clause truncation. */
function applyBlurbs(entries, overrides) {
  return entries.map((entry) => {
    const override = overrides[entry.name];
    const blurb = override
      ? truncateAtWordBoundary(override, entry.maxClauseChars)
      : firstClause(entry.description, entry.maxClauseChars);
    return { name: entry.name, blurb, stamp: entry.stamp };
  });
}

/** A stable, order-independent fingerprint of every source file's path+mtime across the
 * whole catalog, plus any `extraStamps` the caller folds in (the override file(s) — see
 * blurbOverrideStampsFor; a capability's rendered blurb depends on both its own source file
 * AND the overrides file, so both must be able to invalidate the cache). Two scans of an
 * otherwise-unchanged disk produce the same fingerprint; adding, removing, or touching any
 * skill/agent/command file, or the overrides file, changes it. Sorted before hashing so
 * filesystem enumeration order (which readdirSync does not guarantee) never causes a false
 * "changed" reading. sha256 not for any security property (this is a change-detection
 * checksum, nothing here is adversarial) — plain sha1 just trips the linter's blanket
 * weak-hash rule, and sha256 is just as cheap at this size. */
function fingerprintOf(catalog, extraStamps = []) {
  const stamps = Object.values(catalog)
    .flat()
    .map((entry) => entry.stamp)
    .concat(extraStamps)
    .sort();
  return createHash('sha256').update(stamps.join('\n')).digest('hex');
}

/** Strips `stamp` before persisting/rendering — it is scan-time-only plumbing for the
 * fingerprint, not part of the public map shape. */
function withoutStamps(catalog) {
  const stripped = {};
  for (const [kind, entries] of Object.entries(catalog)) {
    stripped[kind] = entries.map(({ name, blurb }) => ({ name, blurb }));
  }
  return stripped;
}

/** Reads the persisted map's catalog + fingerprint + injection counter, or nulls when
 * absent/corrupt. Used to decide whether a rescan is needed and to track injectEveryMessages
 * without a second store file. */
function readPersistedState(mapPath) {
  const data = readJson(mapPath);
  if (!data || typeof data !== 'object') {
    return { catalog: null, fingerprint: null, messageCount: 0 };
  }
  return {
    catalog:
      data.capabilities && typeof data.capabilities === 'object'
        ? data.capabilities
        : null,
    fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : null,
    messageCount: Number.isInteger(data.messageCount) ? data.messageCount : 0,
  };
}

/** Persists the map to .ai/capability-map.json, best-effort — never throws, never blocks. */
function persistMap(cwd, mapFile, catalog, fingerprint, messageCount) {
  const root = projectRootOf(cwd);
  if (!root) return;
  const mapPath = join(root, mapFile);
  const payload = {
    generatedAt: new Date().toISOString(),
    fingerprint,
    messageCount,
    capabilities: withoutStamps(catalog),
  };
  try {
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(
      mapPath,
      `${JSON.stringify(payload, null, JSON_INDENT)}\n`,
      'utf8',
    );
  } catch {
    // The injection is the job; the persisted file is a convenience. A write failure must
    // not break the turn.
  }
}

const KIND_LABELS = {
  skills: 'skills',
  agents: 'agents',
  commands: 'commands',
};

function dumpDefaults() {
  process.stdout.write(
    JSON.stringify({
      id: 'capability-map',
      configKey: CONFIG_KEY,
      enabledByDefault: ENABLED_BY_DEFAULT,
      defaultParams: {
        kinds: DEFAULT_KINDS,
        maxClauseChars: DEFAULT_MAX_CLAUSE_CHARS,
        extraSkillsDirs: [],
        extraAgentsDirs: [],
        extraCommandsDirs: [],
        persist: true,
        mapFile: DEFAULT_MAP_FILE,
        blurbOverridesFile: DEFAULT_BLURB_OVERRIDES_FILE,
        injectEveryMessages: DEFAULT_INJECT_EVERY_MESSAGES,
      },
    }),
  );
}

/** The non-empty raw catalog (description/maxClauseChars/stamp per entry — no blurbs yet),
 * keyed by kind, in the order `kinds` lists them. */
function buildRawCatalog(kinds, cwd, config, maxClauseChars) {
  const catalog = {};
  for (const kind of kinds) {
    const entries = entriesForKind(kind, cwd, config, maxClauseChars);
    if (entries.length > 0) catalog[kind] = entries;
  }
  return catalog;
}

/** The injected text for a catalog, grouped and captioned per kind. */
function renderCatalog(catalog, kinds) {
  const sections = [];
  for (const kind of kinds) {
    const entries = catalog[kind];
    if (!entries) continue;
    const label = KIND_LABELS[kind] || kind;
    const lines = entries.map((entry) =>
      entry.blurb ? `  ${entry.name} — ${entry.blurb}` : `  ${entry.name}`,
    );
    sections.push(`${label}:\n${lines.join('\n')}`);
  }
  return `[capabilities] available (check before improvising something one of these covers):\n${sections.join('\n')}\n`;
}

/** Every tunable read out of the raw config object, with its default applied — keeps main()
 * a single flat read instead of five inline `config.x || DEFAULT_X` expressions. */
function resolvedConfig(config) {
  return {
    maxClauseChars: Number(config.maxClauseChars) || DEFAULT_MAX_CLAUSE_CHARS,
    kinds: Array.isArray(config.kinds) ? config.kinds : DEFAULT_KINDS,
    mapFile: config.mapFile || DEFAULT_MAP_FILE,
    blurbOverridesFile:
      config.blurbOverridesFile || DEFAULT_BLURB_OVERRIDES_FILE,
    injectEveryMessages:
      Number(config.injectEveryMessages) || DEFAULT_INJECT_EVERY_MESSAGES,
    persist: config.persist !== false,
  };
}

/** The rendered { name, blurb } catalog for this run: reused verbatim from the persisted
 * map when disk is provably unchanged since the last scan (same fingerprint), or freshly
 * derived (overrides applied, then mechanical truncation for the rest) otherwise. Re-
 * deriving is the only per-entry work worth skipping — everything downstream only ever
 * sees { name, blurb }, never `stamp`/`description`/`maxClauseChars`. */
function resolveCatalog(rawCatalog, persisted, fingerprint, cwd, settings) {
  if (persisted.fingerprint === fingerprint && persisted.catalog) {
    return persisted.catalog;
  }
  const overrides = blurbOverridesFor(cwd, settings.blurbOverridesFile);
  const rendered = Object.fromEntries(
    Object.entries(rawCatalog).map(([kind, entries]) => [
      kind,
      applyBlurbs(entries, overrides),
    ]),
  );
  return withoutStamps(rendered);
}

/** Whether this run should inject the rendered catalog, and the counter value to persist
 * either way. A fingerprint change forces immediate injection: either this is the very
 * first run for this project (persisted.fingerprint is null — nothing has ever been
 * injected, and waiting up to injectEveryMessages turns before the model learns these
 * capabilities exist is the wrong default) or the disk catalog changed since the last scan
 * (a capability was added/removed — worth surfacing right away, not on whatever the counter
 * happens to be). Both reset the counter, same as a normal throttled trigger. */
function injectionDecision(persisted, fingerprint, injectEveryMessages) {
  const catalogChanged = persisted.fingerprint !== fingerprint;
  const nextMessageCount = persisted.messageCount + 1;
  const shouldInject =
    catalogChanged || nextMessageCount >= injectEveryMessages;
  return { shouldInject, messageCount: shouldInject ? 0 : nextMessageCount };
}

function main() {
  if (process.env[DUMP_ENV]) {
    dumpDefaults();
    return;
  }

  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();

  const config = gateConfig(cwd);
  const isEnabled =
    config.enabled === undefined ? ENABLED_BY_DEFAULT : config.enabled;
  if (!isEnabled) return;

  const settings = resolvedConfig(config);
  const rawCatalog = buildRawCatalog(
    settings.kinds,
    cwd,
    config,
    settings.maxClauseChars,
  );
  if (Object.keys(rawCatalog).length === 0) return; // nothing to surface: never overwrite a good map

  const overrideStamps = blurbOverrideStampsFor(
    cwd,
    settings.blurbOverridesFile,
  );
  const fingerprint = fingerprintOf(rawCatalog, overrideStamps);
  const root = projectRootOf(cwd);
  const mapPath = root ? join(root, settings.mapFile) : null;
  const persisted = mapPath
    ? readPersistedState(mapPath)
    : { catalog: null, fingerprint: null, messageCount: 0 };

  const catalog = resolveCatalog(
    rawCatalog,
    persisted,
    fingerprint,
    cwd,
    settings,
  );

  const { shouldInject, messageCount } = injectionDecision(
    persisted,
    fingerprint,
    settings.injectEveryMessages,
  );

  if (settings.persist && mapPath) {
    persistMap(cwd, settings.mapFile, catalog, fingerprint, messageCount);
  }

  if (shouldInject) {
    process.stdout.write(renderCatalog(catalog, settings.kinds));
  }
}

main();
