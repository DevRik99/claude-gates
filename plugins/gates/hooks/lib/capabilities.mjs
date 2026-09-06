// capabilities.mjs — the shared definition of "what AI capabilities does this project
// have". Discovery is one implementation here, so the two halves of the capability pair
// cannot drift apart, exactly like lib/tools.mjs serves reuse-before-build and tool-map:
//   · capability-map (UserPromptSubmit) renders the catalog INTO the model's context;
//   · skill-first (PreToolUse) reads the same catalog to judge whether the action about
//     to run has a skill that already covers it.
// Two gates deriving the catalog from two private copies of `readdirSync` was the drift
// this module exists to prevent.
//
// The catalog IS the directory listing, never a hardcoded copy, so it is autosynced by
// construction. Project roots are scanned BEFORE ~/.claude so a project capability
// shadows a global one of the same name. `.agents/skills` and `.ai/skills` (home and
// project) are scanned as skill-only roots because other installers write there.
//
// Node built-ins only: a gate importing this must keep working installed on its own.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';

export const KIND_EXTENSIONS = Object.freeze({
  agents: ['.md'],
  commands: ['.md', '.toml'],
});

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function mtimeMsOf(path) {
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
export function parseFrontMatter(fileText) {
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

export function truncateAtWordBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;
  const budget = text.slice(0, maxChars - 1);
  const lastSpace = budget.lastIndexOf(' ');
  const cut = lastSpace > 0 ? budget.slice(0, lastSpace) : budget;
  return `${cut.trimEnd()}…`;
}

export function firstClause(description, maxClauseChars) {
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

export function skillRootsFor(root, extraDirectories = []) {
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

export function fileRootsFor(root, kind, extraDirectories = []) {
  return [
    join(root, '.claude', kind),
    join(homedir(), '.claude', kind),
    ...extraDirectories.map((directory) => resolveExtra(root, directory)),
  ];
}

function extraDirectoriesFor(kind, settings) {
  if (kind === 'agents') return settings.extraAgentsDirs ?? [];
  if (kind === 'commands') return settings.extraCommandsDirs ?? [];
  return settings.extraSkillsDirs ?? [];
}

function collectKind(kind, root, settings) {
  const extra = extraDirectoriesFor(kind, settings);
  if (kind === 'skills')
    return skillRootsFor(root, extra).flatMap(skillEntriesUnder);
  const extensions = KIND_EXTENSIONS[kind];
  if (!extensions) return [];
  return fileRootsFor(root, kind, extra).flatMap((directory) =>
    fileEntriesUnder(directory, extensions),
  );
}

// First occurrence wins, and project roots come first: a project capability shadows a
// global one of the same name.
export function entriesForKind(kind, root, settings = {}) {
  const seen = new Set();
  const unique = [];
  for (const entry of collectKind(kind, root, settings)) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    unique.push(entry);
  }
  return unique.sort((a, b) => a.name.localeCompare(b.name));
}

/** The raw catalog `{ kind: [{ name, description, stamp }] }`, kinds with no entry omitted. */
export function buildRawCatalog(root, settings) {
  const catalog = {};
  for (const kind of settings.kinds) {
    const entries = entriesForKind(kind, root, settings);
    if (entries.length > 0) catalog[kind] = entries;
  }
  return catalog;
}

// ── Relevance ───────────────────────────────────────────────────────────────────────
// Which capabilities plausibly cover the action about to run. Deliberately a LEXICAL
// heuristic over the catalog's own front matter, not a model call: a gate is a
// deterministic process with no network, and a skill's `description` is already written
// as its trigger ("Use when the user asks about…"), so it is the honest thing to match
// against. Two independent signals, because each alone is weak:
//   · the capability's NAME appearing in the action text — precise, near zero false
//     positives, but silent whenever the model never names the skill (the common case);
//   · TOKEN OVERLAP with the description — catches the unnamed case, at the cost of
//     needing a threshold to stay quiet.
// Honest limitation: no lexical rule recognizes a paraphrase that shares no vocabulary
// with the description. This narrows the blind spot, it does not close it — which is why
// the gate that consumes it ships off by default and clears on an explicit statement.

const MIN_TOKEN_LENGTH = 4;
const NAME_MATCH_SCORE = 100;
const DEFAULT_MIN_TOKEN_OVERLAP = 3;
const DEFAULT_MAX_MATCHES = 3;
const MAX_TEXT_CHARS = 20000;

// Words carrying no discriminating power in this domain: they appear in almost every
// skill description AND in almost every prompt, so counting them as overlap would make
// every action match every skill. ES + EN, matching lib/signals.mjs's bilingual scope.
const STOPWORDS = new Set(
  (
    'this that they them then than with when what which while where whose whom about ' +
    'into onto from over under after before during your yours their there these those ' +
    'have has had having been being does doing done should would could must will shall ' +
    'also only just very much more most less least other others same such each every ' +
    'user users use uses used using make makes made need needs needed want wants ' +
    'skill skills agent agents command commands claude anthropic tool tools ' +
    'file files code codebase project projects repo repository directory folder ' +
    'work works working task tasks thing things stuff item items step steps ' +
    'help helps helping ask asks asked answer answers question questions ' +
    'para pero como cuando donde porque aunque desde hasta sobre entre segun ' +
    'este esta estos estas esto aquel aquella ellos ellas nosotros ustedes ' +
    'tiene tienen tener teniendo hacer hace hacen hecho hacia siendo estar ' +
    'debe deben debes puede pueden podes podemos quiere quieren necesita necesitan ' +
    'usuario usuarios usar usando usa archivo archivos carpeta directorio ' +
    'proyecto proyectos codigo tarea tareas cosa cosas paso pasos ' +
    'cualquier cualquiera todos todas alguno alguna mismo misma otro otra ' +
    'ayuda ayudar pregunta preguntas respuesta respuestas'
  ).split(/\s+/),
);

const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

/** Distinctive lowercase tokens of a text: long enough, and not a domain stopword. */
export function distinctiveTokens(text) {
  const tokens = new Set();
  for (const raw of String(text ?? '')
    .slice(0, MAX_TEXT_CHARS)
    .toLowerCase()
    .split(WORD_SEPARATOR)) {
    if (raw.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

function escapeRegExpSource(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A capability's name is written `code-review` / `a11y_doctrine` but referred to in prose
// as "code review", so both spellings must count as naming it.
function namePattern(name) {
  const spaced = String(name)
    .split(/[-_]/)
    .filter(Boolean)
    .map(escapeRegExpSource)
    .join('[\\s\\-_]*');
  if (!spaced) return null;
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}_])${spaced}(?![\\p{L}\\p{N}_])`, 'iu');
  } catch {
    return null;
  }
}

function triggerTokensOf(entry) {
  return distinctiveTokens(
    `${String(entry.name).replace(/[-_]/g, ' ')} ${entry.description ?? ''}`,
  );
}

// How many catalog entries mention each token. A token nearly every skill uses
// ("analytics", "build") says almost nothing about WHICH skill fits, while a token only
// one skill uses ("tooltip") is close to decisive — so ranking by a raw token count
// hands the match to whichever skill happens to have the longest, most generic
// description. Weighting each shared token by 1/frequency is what makes the deny name
// the skill that actually fits: it is the ranking, not the threshold, so `minTokenOverlap`
// keeps meaning a plain, predictable count of shared tokens.
function documentFrequencies(tokenSets) {
  const frequencies = new Map();
  for (const tokens of tokenSets) {
    for (const token of tokens)
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

function scoreEntry(
  entry,
  triggerTokens,
  actionTokens,
  actionText,
  frequencies,
) {
  const pattern = namePattern(entry.name);
  const named = pattern !== null && pattern.test(actionText);
  const shared = [];
  let weight = 0;
  for (const token of triggerTokens) {
    if (!actionTokens.has(token)) continue;
    shared.push(token);
    weight += 1 / (frequencies.get(token) ?? 1);
  }
  // The rarest shared tokens first, so the deny message explains the match with the
  // words that actually drove it.
  shared.sort((a, b) => (frequencies.get(a) ?? 1) - (frequencies.get(b) ?? 1));
  return {
    named,
    overlap: shared.length,
    shared,
    score: (named ? NAME_MATCH_SCORE : 0) + weight,
  };
}

/**
 * The capabilities that plausibly cover `actionText`, strongest first. A capability
 * qualifies when the action NAMES it, or when it shares at least `minTokenOverlap`
 * distinctive tokens with its description. Returns `[]` — the common, silent path —
 * whenever nothing clears the bar.
 */
export function relevantCapabilities(actionText, entries, options = {}) {
  const minTokenOverlap = options.minTokenOverlap ?? DEFAULT_MIN_TOKEN_OVERLAP;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const text = String(actionText ?? '').slice(0, MAX_TEXT_CHARS);
  if (!text.trim()) return [];
  const actionTokens = distinctiveTokens(text);
  if (actionTokens.size === 0) return [];

  const named = (entries ?? []).filter((entry) => entry?.name);
  const tokenSets = named.map(triggerTokensOf);
  const frequencies = documentFrequencies(tokenSets);

  const matches = [];
  for (const [index, entry] of named.entries()) {
    const scored = scoreEntry(
      entry,
      tokenSets[index],
      actionTokens,
      text,
      frequencies,
    );
    if (!scored.named && scored.overlap < minTokenOverlap) continue;
    matches.push({ name: entry.name, ...scored });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, maxMatches);
}

// ── The audit statement that clears the check ───────────────────────────────────────
// One explicit sentence, in the written content or the delegation prompt, in ES or EN.
// The point is not the wording: it is that a decision about skills was made and recorded
// where a reader will see it, instead of the question never being asked.
// An optional capability name may sit between the verb and the noun ("using the dataviz
// skill"), so the name is allowed but never required.
const AUDIT_NAME = String.raw`(?:the\s+)?(?:[\w./-]+\s+)?`;

export const SKILL_AUDIT_PATTERN = new RegExp(
  [
    String.raw`(?:using|used|use|via|per|applying|apply)\s+${AUDIT_NAME}skills?\b`,
    String.raw`\bskills?\s*[:=]\s*\S`,
    String.raw`\bno\s+skills?\s+(?:covers?|applies|apply|matches|match|fits)\b`,
    String.raw`\bskill[-\s]checked\b`,
    String.raw`(?:ninguna|sin)\s+skill`,
    String.raw`(?:usando|uso|use|aplicando)\s+(?:la\s+)?(?:[\w./-]+\s+)?skill`,
    String.raw`\bskill\s+(?:relevante|aplicable)`,
  ].join('|'),
  'iu',
);

/** Whether a text carries the explicit statement that skills were considered. */
export function hasSkillAuditEvidence(text) {
  return SKILL_AUDIT_PATTERN.test(String(text ?? ''));
}
