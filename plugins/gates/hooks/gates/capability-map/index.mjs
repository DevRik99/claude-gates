// capability-map — UserPromptSubmit hook. Surfaces the REAL, current catalog of the project's
// AI capabilities — skills, agents/subagents, and commands — as compact data ("caveman"
// format: `name — first clause`, one line each, grouped by kind), read fresh from disk on
// every message. It also PERSISTS that catalog to .ai/capability-map.json so the map is easy
// to follow and read the same way the tool map (.ai/tool-map.json) is, and so another tool or
// a human can consult it without re-scanning. Autosynced by construction: add or remove a
// skill/agent/command file and the next message reflects it, because the map IS the directory
// listing, never a hardcoded copy.
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
// ── Skills also scanned outside the .claude layout, unconditionally ────────────────────
// `~/.agents/skills`, `<project>/.agents/skills`, `~/.ai/skills`, `<project>/.ai/skills` are
// scanned as skill roots by default (no config needed) alongside `.claude/skills` — these
// are skill directories other installers are known to use (`.agents/skills` is what the
// `skills` CLI several installers shell out to writes when run without its `-g` flag: a
// project-local skill tree, not `~/.claude`). Agents/commands are NOT looked for under these
// roots — only `.claude` is known to lay those out as siblings of `skills`.
//
// ── What a project can configure (params) — everything is customizable ───────────────
//   kinds            which capability kinds to include, e.g. ["skills","agents","commands"].
//                    Drop one to stop scanning it entirely.
//   maxClauseChars   hard cap on each entry's one-line blurb (default 90).
//   extraSkillsDirs / extraAgentsDirs / extraCommandsDirs   additional roots per kind
//                    (relative to project or absolute), added on top of the built-in ones.
//   persist          whether to write .ai/capability-map.json (default true).
//   mapFile          path to the persisted map, relative to project root. Default
//                    .ai/capability-map.json.
//
// ── Fail-safe shape ──────────────────────────────────────────────────────────────────
// Nothing found anywhere, gate disabled, or unreadable input: inject nothing (silent, no
// wasted context) — and never write an empty map over a good one. Persistence failure is
// swallowed: the injection is the job, the file is a convenience. Never blocks —
// UserPromptSubmit cannot deny; it only adds context.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';

const STDIN_FILE_DESCRIPTOR = 0;
const CONFIG_KEY = 'injectCapabilityMap';
const DUMP_ENV = 'CLAUDE_GATES_DUMP_DEFAULTS';
const DEFAULT_MAX_CLAUSE_CHARS = 90;
const DEFAULT_KINDS = ['skills', 'agents', 'commands'];
const DEFAULT_MAP_FILE = join('.ai', 'capability-map.json');
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

/** The capability-map gate config entry (project overrides global), or null. */
function gateConfig(startDirectory) {
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

/** The description's first clause, capped — the caveman blurb. */
function firstClause(description, maxClauseChars) {
  if (!description) return '';
  const sentenceEnd = description.indexOf('. ');
  const clause =
    sentenceEnd > 0 ? description.slice(0, sentenceEnd) : description;
  return clause.length > maxClauseChars
    ? `${clause.slice(0, maxClauseChars - 1).trimEnd()}…`
    : clause;
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

/** Skill capabilities under one root: <root>/skills/<name>/SKILL.md. */
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
    if (!existsSync(skillFile)) continue;
    let content;
    try {
      content = readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const { name, description } = parseFrontMatter(content);
    entries.push({
      name: name || skillDirectory.name,
      blurb: firstClause(description, maxClauseChars),
    });
  }
  return entries;
}

/** Agent/command capabilities: flat or nested files whose front matter carries a description. */
function fileEntriesUnder(directory, extensions, maxClauseChars) {
  const entries = [];
  for (const file of filesUnder(directory, extensions)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { name, description } = parseFrontMatter(content);
    entries.push({
      name: name || basename(file, extname(file)),
      blurb: firstClause(description, maxClauseChars),
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

/** Every entry for one kind across all roots, de-duplicated by name. */
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

/** Persists the map to .ai/capability-map.json, best-effort — never throws, never blocks. */
function persistMap(cwd, mapFile, catalog) {
  const root = projectRootOf(cwd);
  if (!root) return;
  const mapPath = join(root, mapFile);
  const payload = {
    generatedAt: new Date().toISOString(),
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
      enabledByDefault: false,
      defaultParams: {
        kinds: DEFAULT_KINDS,
        maxClauseChars: DEFAULT_MAX_CLAUSE_CHARS,
        extraSkillsDirs: [],
        extraAgentsDirs: [],
        extraCommandsDirs: [],
        persist: true,
        mapFile: DEFAULT_MAP_FILE,
      },
    }),
  );
}

/** The non-empty catalog keyed by kind, in the order `kinds` lists them. */
function buildCatalog(kinds, cwd, config, maxClauseChars) {
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

function main() {
  if (process.env[DUMP_ENV]) {
    dumpDefaults();
    return;
  }

  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();

  const config = gateConfig(cwd);
  if (!config || config.enabled !== true) return; // opt-in: off unless explicitly enabled

  const maxClauseChars =
    Number(config.maxClauseChars) || DEFAULT_MAX_CLAUSE_CHARS;
  const kinds = Array.isArray(config.kinds) ? config.kinds : DEFAULT_KINDS;

  const catalog = buildCatalog(kinds, cwd, config, maxClauseChars);
  if (Object.keys(catalog).length === 0) return; // nothing to surface: never overwrite a good map

  if (config.persist !== false) {
    persistMap(cwd, config.mapFile || DEFAULT_MAP_FILE, catalog);
  }

  process.stdout.write(renderCatalog(catalog, kinds));
}

main();
