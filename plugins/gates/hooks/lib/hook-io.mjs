// Process I/O shared by every gate. Self-contained: Node built-ins only, so a gate keeps
// working when installed outside this repo.
//
// There is no dispatcher: Claude Code runs one hook entry per gate natively (each with its
// own `matcher`, all matching entries in parallel), so each gate is its own process and
// reads its own stdin. This module holds what every gate needs, none of it gate-specific:
//   1. Reading and parsing the hook payload Claude Code writes to stdin.
//   2. Translating the registry's semantic tool groups (write/shell/...) into the concrete
//      tool names Claude Code sends — used to derive each gate's `matcher` and, when a gate
//      also inspects delegation prompts, to recognize the tool at runtime.
//   3. Reading a shell command, a written path/content, or a delegation prompt out of the
//      many field shapes native and MCP tools use.
//   4. Compiling config-supplied regex lists safely, and coercing config params to the
//      type the gate's own defaults declare (a typo in .ai/config.json must never turn
//      into "deny every tool call").
//   5. Emitting a deny/warn/allow decision in the JSON shape Claude Code expects, and
//      recording every deny/warn/block in the project's decision log.
//   6. The scaffolding (`runGate`, `runStopHook`) that turns a gate file into just its rule.

import { readFileSync } from 'node:fs';
import { gateParameters, isGateEnabled } from './config.mjs';
import { DECISIONS, logDecision } from './gate-log.mjs';
import { readSessionState, writeSessionState } from './session-state.mjs';

const STDIN_FILE_DESCRIPTOR = 0;

/**
 * Semantic tool groups (as declared in registry.json's `tools`) mapped to the concrete
 * tool names Claude Code emits. Keeping the map here (not in the registry) keeps the
 * catalog declarative: which tool names exist is a fact about the Claude Code runtime,
 * not about the gate. `matcherFor` turns a group set into the `Tool1|Tool2` string a
 * hooks.json entry uses; `toolNamesFor` gives the flat list a gate matches at runtime.
 */
export const TOOL_GROUPS = Object.freeze({
  write: [
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'write_to_file',
    'replace_file_content',
  ],
  shell: ['Bash', 'run_command', 'PowerShell'],
  delegation: ['Agent', 'Task', 'invoke_subagent'],
  question: ['AskUserQuestion'],
  // The main agent materializing a change directly, whatever the surface.
  execution: [
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
    'write_to_file',
    'replace_file_content',
    'Bash',
    'run_command',
    'PowerShell',
    'mcp__ide__executeCode',
  ],
  // Research surfaces: the web and documentation lookups the research gates sequence.
  research: ['WebSearch', 'WebFetch'],
});

/** Every concrete tool name a set of groups expands to, de-duplicated. */
export function toolNamesFor(groups) {
  const names = new Set();
  for (const group of groups) {
    for (const name of TOOL_GROUPS[group] ?? []) names.add(name);
  }
  return [...names];
}

/**
 * MCP tools are named `mcp__<server>__<tool>`, and any connected server can expose a write,
 * shell, delegation or ask surface under a name this repo has never seen. Enumerating exact
 * names (the old approach) left every such tool invisible: the gate never fired. Instead,
 * each group carries a substring rule matched against the MCP tool's action segment, so a
 * NEW server's `mcp__fs__write_file` or `mcp__shell__exec` is classified by what it does, not
 * by a name we had to know in advance. The rule intentionally over-includes (a false match
 * makes a gate inspect a payload it then finds benign — cheap) rather than under-includes (a
 * miss is a silent hole). `question` stays deny-heavy so autonomous mode cannot be dodged by
 * an MCP ask tool. Native (non-mcp) names are still matched exactly via TOOL_GROUPS.
 */
const MCP_GROUP_SIGNALS = Object.freeze({
  write:
    /(?:write|edit|create|append|patch|replace|insert|modify|save|update)/i,
  shell:
    /(?:shell|bash|exec|run|command|terminal|process|spawn|cmd|powershell|sh)/i,
  delegation:
    /(?:agent|task|delegat|subagent|spawn|dispatch|orchestrat|worker)/i,
  question: /(?:ask|question|confirm|prompt|approv|choice|elicit|clarif)/i,
  execution:
    /(?:write|edit|create|append|patch|replace|insert|modify|save|update|shell|bash|exec|run|command|terminal|process|spawn|cmd|powershell|sh)/i,
  research: /(?:search|fetch|browse|docs|documentation|library|lookup|query)/i,
});

const MCP_TOOL_PREFIX = 'mcp__';
// mcp__<server>__<action>: prefix + server + action, three underscore-delimited segments.
const MCP_TOOL_NAME_SEGMENT_COUNT = 3;

/** The action segment of an MCP tool name (`mcp__server__do_thing` -> `do_thing`), or ''. */
export function mcpActionSegment(toolName) {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return '';
  const parts = toolName.split('__');
  return parts.length >= MCP_TOOL_NAME_SEGMENT_COUNT
    ? parts.slice(2).join('__')
    : '';
}

/** The server segment of an MCP tool name (`mcp__engram__mem_save` -> `engram`), or ''. */
export function mcpServerSegment(toolName) {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return '';
  const parts = toolName.split('__');
  return parts.length >= MCP_TOOL_NAME_SEGMENT_COUNT ? parts[1] : '';
}

/**
 * Whether a tool name belongs to any of the given groups. A native tool matches by exact
 * membership; an MCP tool (`mcp__*`) matches when its action segment hits the group's signal
 * regex. This is what every gate should use instead of a private `Set.has(toolName)` — the
 * private sets were the second half of the MCP blind spot (even a payload that reached the
 * gate was rejected by an exact-name check).
 */
export function toolInGroups(toolName, groups) {
  if (!toolName) return false;
  const native = toolNamesFor(groups);
  // Native tool names from Claude Code are canonical (`AskUserQuestion`), but match
  // case-insensitively so a differently-cased spelling from any surface can't dodge a gate.
  const lowered = String(toolName).toLowerCase();
  if (native.some((name) => name.toLowerCase() === lowered)) return true;
  const action = mcpActionSegment(String(toolName));
  if (!action) return false;
  return groups.some((group) => MCP_GROUP_SIGNALS[group]?.test(action));
}

/**
 * The `matcher` string for a hooks.json entry. Native names are listed explicitly; a trailing
 * `mcp__.*` alternative makes Claude Code also route EVERY MCP tool call to the hook, so the
 * gate can classify it at runtime with `toolInGroups`. Without the `mcp__.*` clause the hook
 * is never even invoked for an MCP tool — the deepest layer of the blind spot, since no
 * runtime check can compensate for a hook that never runs.
 */
export function matcherFor(groups) {
  return [...toolNamesFor(groups), String.raw`mcp__.*`].join('|');
}

/**
 * The content a write-style tool is about to put on disk, across every native and MCP field
 * shape seen in the wild: Write/create (`content`), Edit (`new_string`), NotebookEdit
 * (`new_source`), MultiEdit (`edits[].new_string`), replace_file_content (`new_content`,
 * `ReplacementContent`), and MCP variants (`text`, `data`, `CodeContent`). Returns '' when
 * none is present. A gate that inspects written text MUST read through this, so a differently
 * shaped payload can no longer degrade silently to '' and slip past.
 */
export function writtenContentOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((edit) =>
        String(edit?.new_string ?? edit?.new_source ?? edit?.content ?? ''),
      )
      .join('\n');
  }
  const direct =
    toolInput.content ??
    toolInput.new_string ??
    toolInput.new_source ??
    toolInput.new_content ??
    toolInput.ReplacementContent ??
    toolInput.CodeContent ??
    toolInput.text ??
    toolInput.data ??
    '';
  return typeof direct === 'string' ? direct : String(direct ?? '');
}

/** The file path a write-style tool targets, across native and MCP field shapes. */
export function writtenPathOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const path =
    toolInput.file_path ??
    toolInput.path ??
    toolInput.target_file ??
    toolInput.notebook_path ??
    toolInput.filename ??
    toolInput.uri ??
    '';
  return typeof path === 'string' ? path : String(path ?? '');
}

/** The command line a shell-style tool is about to run, across field shapes; '' if none. */
export function shellCommandOf(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  const command =
    toolInput.command ?? toolInput.CommandLine ?? toolInput.cmd ?? '';
  return typeof command === 'string' ? command : String(command ?? '');
}

/** The brief/prompt a delegation carries, across native and MCP field shapes. */
export function delegationPromptOf(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const prompt =
    toolInput.prompt ??
    toolInput.Prompt ??
    toolInput.description ??
    toolInput.task ??
    toolInput.instructions ??
    toolInput.message ??
    toolInput.input ??
    '';
  return typeof prompt === 'string' ? prompt : String(prompt ?? '');
}

/**
 * The text a gate should inspect for a tool in the shell OR delegation group: the command
 * line for a shell tool, the prompt for a delegation. '' for anything else.
 */
export function commandOrPromptOf(toolName, toolInput) {
  if (toolInGroups(toolName, ['shell'])) return shellCommandOf(toolInput);
  if (toolInGroups(toolName, ['delegation']))
    return delegationPromptOf(toolInput);
  return '';
}

// ── Shell-created paths ─────────────────────────────────────────────────────────────
// A quoted (double, single) or bare argument; the bare form stops at shell metacharacters.
const ARGUMENT = String.raw`"([^"\n]+)"|'([^'\n]+)'|([^\s'"|;&<>()]+)`;
// Shell forms that CREATE or write a file at a named path, so a gate protecting a path can
// see a `printf ... > file` the same way it sees a Write. Each pattern captures the target
// path in groups 1..3 (quoted-double, quoted-single, bare). Conservative by design: it
// over-detects (a gate then finds the path benign) rather than under-detects. It does NOT
// resolve variables or command substitution — a path built dynamically (`> "$f"`) is not
// extracted; that limitation is the honest boundary of a regex.
const SHELL_WRITE_PATTERNS = [
  // redirection: `> file`, `>> file`, `1> file`, `2> file`, `&> file`, also with no space
  // before the `>` (`echo hi>file`). A `>` that is part of `<>`/`>>` is consumed whole.
  new RegExp(String.raw`(?<![<>])(?:\d|&)?>>?\s*(?:${ARGUMENT})`, 'g'),
  // touch / tee / mkdir target(s): every non-flag argument up to the next separator
  new RegExp(
    String.raw`(?:^|[;&|(]|\|\||&&)\s*(?:touch|tee|mkdir|mkdir -p)\s+(?:-\S+\s+)*((?:(?:"[^"\n]+"|'[^'\n]+'|[^\s'"|;&<>()]+)\s*)+)`,
    'g',
  ),
  // cp / mv / install: the LAST argument is the destination
  new RegExp(
    String.raw`(?:^|[;&|(]|\|\||&&)\s*(?:cp|mv|install)\s+(?:-\S+\s+)*((?:(?:"[^"\n]+"|'[^'\n]+'|[^\s'"|;&<>()]+)\s*)+)`,
    'g',
  ),
  // git clone [opts] <url> [dest]
  new RegExp(
    String.raw`\bgit\s+clone\s+(?:-{1,2}\S+(?:\s+\S+)?\s+)*(\S+)(?:\s+(?:${ARGUMENT}))?`,
    'g',
  ),
  // curl -o / wget -O / --output <file>
  new RegExp(
    String.raw`\b(?:curl|wget)\b[^;&|\n]*?\s(?:-o|-O|--output)(?:=|\s+)(?:${ARGUMENT})`,
    'g',
  ),
  // PowerShell: Set-Content/Add-Content/Out-File/New-Item/Copy-Item/Move-Item/Tee-Object,
  // with the path as -Path/-FilePath/-Destination/-LiteralPath or the first bare argument
  new RegExp(
    String.raw`\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Tee-Object|Export-Csv|ConvertTo-Json\s*\|\s*Out-File)\b(?:\s+-(?:Path|FilePath|Destination|LiteralPath)\s+|\s+(?!-))(?:${ARGUMENT})`,
    'gi',
  ),
];

const MULTI_TARGET_PATTERN_INDEXES = new Set([1, 2]);
const CLONE_PATTERN_INDEX = 3;

function argumentValue(match) {
  return match[1] ?? match[2] ?? match[3] ?? '';
}

function splitTargets(list) {
  const targets = [];
  for (const match of String(list).matchAll(new RegExp(ARGUMENT, 'g')))
    targets.push(argumentValue(match));
  return targets;
}

function cloneDestination(match) {
  const explicit = match[2] ?? match[3] ?? match[4];
  if (explicit) return explicit;
  const url = String(match[1] ?? '');
  const base = url.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return base.replace(/\.git$/i, '');
}

/**
 * Every filesystem path a shell command appears to create or write to (redirections, touch,
 * tee, mkdir, cp/mv destinations, git clone, curl/wget output, PowerShell writers). Returns a
 * de-duplicated list, empty when none is found. A gate that protects paths should check these
 * IN ADDITION to writtenPathOf, or a shell redirection slips past it.
 */
export function shellWrittenPaths(command) {
  const text = String(command ?? '');
  const found = new Set();
  SHELL_WRITE_PATTERNS.forEach((pattern, index) => {
    for (const match of text.matchAll(pattern)) {
      let targets;
      if (MULTI_TARGET_PATTERN_INDEXES.has(index)) {
        const all = splitTargets(match[1]);
        // cp/mv/install: destination is the last argument; touch/tee/mkdir: all of them.
        targets = index === 2 ? all.slice(-1) : all;
      } else if (index === CLONE_PATTERN_INDEX) {
        targets = [cloneDestination(match)];
      } else {
        targets = [argumentValue(match)];
      }
      for (const path of targets) {
        // Skip a dynamically built target (a variable/substitution): we cannot resolve `$f`,
        // `${x}` or `$(…)` to a real path, and guessing would only add false positives.
        if (path && !/[$`%]/.test(path) && path !== '-') found.add(path);
      }
    }
  });
  return [...found];
}

// ── Payload readers ─────────────────────────────────────────────────────────────────

/** Reads the raw hook payload from stdin. Returns null when stdin cannot be read. */
export function readHookPayload() {
  try {
    return readFileSync(STDIN_FILE_DESCRIPTOR, 'utf8');
  } catch {
    return null;
  }
}

function parsePayload(rawPayload) {
  try {
    const payload = JSON.parse(rawPayload);
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return null;
  }
}

/**
 * The tool name inside a raw payload. Returns null when the payload is unparseable —
 * the caller cannot filter by tool then, so it must run every gate rather than skip
 * silently (erring toward over-running protects; erring toward skipping leaves a mute hole).
 */
export function toolNameOf(rawPayload) {
  const payload = parsePayload(rawPayload);
  if (payload === null) return null;
  return String(payload.tool_name ?? payload.name ?? '');
}

/** The session id inside a raw payload, or null when absent/unparseable. */
export function sessionIdOf(rawPayload) {
  const payload = parsePayload(rawPayload);
  const id = payload?.session_id;
  return id === undefined || id === null ? null : String(id);
}

/** The tool input object inside a raw payload, or {} when absent/unparseable. */
export function toolInputOf(rawPayload) {
  const payload = parsePayload(rawPayload);
  const input = payload?.tool_input ?? payload?.input;
  return input && typeof input === 'object' ? input : {};
}

/** The tool response (PostToolUse payloads), or null when absent. */
export function toolResponseOf(rawPayload) {
  const payload = parsePayload(rawPayload);
  return payload?.tool_response ?? payload?.tool_result ?? null;
}

// ── Regex and parameter helpers ─────────────────────────────────────────────────────

/** Escapes a literal for use inside a RegExp source. */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A compiled RegExp from a source, or null when the source is not a valid pattern. */
export function compileRegex(source, flags = 'i') {
  if (typeof source !== 'string' || source.length === 0) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * Compiles a config-supplied list of regex sources, SKIPPING malformed or non-string
 * entries instead of throwing. Returns { patterns, invalid } so a gate can mention what it
 * ignored. A non-array input yields no patterns.
 */
export function compileRegexList(sources, flags = 'i') {
  const patterns = [];
  const invalid = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const pattern = compileRegex(source, flags);
    if (pattern) patterns.push(pattern);
    else invalid.push(String(source));
  }
  return { patterns, invalid };
}

/**
 * Normalizes a rule list that may mix bare regex sources and `[source, reason]` pairs into
 * `{ source, reason }` objects, dropping entries that are neither. The registry documents
 * the bare form; the gates' defaults ship pairs — both must work.
 */
export function normalizeRulePairs(rules, defaultReason) {
  const normalized = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (typeof rule === 'string') {
      normalized.push({ source: rule, reason: defaultReason });
    } else if (Array.isArray(rule) && typeof rule[0] === 'string') {
      normalized.push({
        source: rule[0],
        reason: typeof rule[1] === 'string' ? rule[1] : defaultReason,
      });
    } else if (
      rule &&
      typeof rule === 'object' &&
      typeof rule.source === 'string'
    ) {
      normalized.push({
        source: rule.source,
        reason: typeof rule.reason === 'string' ? rule.reason : defaultReason,
      });
    }
  }
  return normalized;
}

// One coercion rule per default type: returns the accepted value, or undefined to reject.
const COERCIONS = {
  array: (declared) => (Array.isArray(declared) ? declared : undefined),
  number: (declared) => {
    if (declared === '' || declared === null) return undefined;
    const number = Number(declared);
    return Number.isFinite(number) ? number : undefined;
  },
  boolean: (declared) => {
    if (typeof declared === 'boolean') return declared;
    if (declared === 'true' || declared === 'false') return declared === 'true';
    return undefined;
  },
  string: (declared) =>
    typeof declared === 'string' || declared === null ? declared : undefined,
};

function expectedTypeOf(fallback) {
  if (Array.isArray(fallback)) return 'array';
  if (fallback === null) return 'string';
  return typeof fallback;
}

function coerceOne(key, fallback, declared) {
  if (declared === undefined) return { value: fallback };
  const expected = expectedTypeOf(fallback);
  const coerce = COERCIONS[expected];
  if (!coerce) return { value: declared };
  const value = coerce(declared);
  if (value !== undefined) return { value };
  return {
    value: fallback,
    problem: {
      key,
      expected,
      got: declared === null ? 'null' : typeof declared,
    },
  };
}

/**
 * Merges a project's declared params over a gate's defaults, coercing each declared value to
 * the TYPE the default has (array, number, boolean, string). A value of the wrong type is
 * replaced by the default and reported in `problems`, so a typo in .ai/config.json degrades
 * to "built-in behavior" instead of "the gate throws and denies everything". Keys the
 * defaults do not know pass through untouched.
 */
export function coerceParameters(defaults, declared) {
  const parameters = { ...(declared ?? {}) };
  const problems = [];
  for (const [key, fallback] of Object.entries(defaults ?? {})) {
    const { value, problem } = coerceOne(key, fallback, declared?.[key]);
    parameters[key] = value;
    if (problem) problems.push(problem);
  }
  return { parameters, problems };
}

// ── Decisions ───────────────────────────────────────────────────────────────────────
const PRE_TOOL_USE_EVENT = 'PreToolUse';

// The gate/tool/session currently being judged, so deny/warn can log a complete line
// without every gate threading that context through. Set by runGate/runStopHook.
let decisionContext = null;

/** Sets what deny/warn/block will record in the decision log for this process. */
export function setDecisionContext(context) {
  decisionContext = context;
}

function record(decision, reason) {
  if (!decisionContext) return;
  logDecision({
    decision,
    gate: decisionContext.gateId,
    configKey: decisionContext.configKey,
    toolName: decisionContext.toolName,
    toolInput: decisionContext.toolInput,
    sessionId: decisionContext.sessionId,
    cwd: decisionContext.cwd,
    reason,
  });
}

/**
 * A gate answers Claude Code in exactly one of three ways, and every gate uses these
 * emitters so the JSON shape is written once:
 *   - deny:  the rule is deterministic and the action is wrong. Blocks the tool call.
 *   - warn:  the question needs judgment; the gate surfaces context at the right moment
 *            (additionalContext) and lets the call proceed.
 *   - allow: nothing to say. The common path — silent and cheap.
 * Each emitter exits the process (exit 0 always: a PreToolUse deny is expressed in the
 * JSON, not in the exit code — reserving exit codes keeps a crash distinguishable).
 *
 * `label` is what prefixes the message so a block names its source; by convention every
 * gate passes its configKey (the thing a user can toggle in .ai/config.json).
 */
export function deny(label, reason) {
  record(DECISIONS.DENY, reason);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: PRE_TOOL_USE_EVENT,
        permissionDecision: 'deny',
        permissionDecisionReason: `[${label}] ${reason}`,
      },
    }),
  );
  process.exit(0);
}

export function warn(label, context) {
  record(DECISIONS.WARN, context);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: PRE_TOOL_USE_EVENT,
        additionalContext: `[${label}] ${context}`,
      },
    }),
  );
  process.exit(0);
}

export function allow() {
  process.exit(0);
}

/** A Stop-hook block: makes the agent continue instead of ending the turn. */
export function block(label, reason) {
  record(DECISIONS.BLOCK, reason);
  process.stdout.write(
    JSON.stringify({ decision: 'block', reason: `[${label}] ${reason}` }),
  );
  process.exit(0);
}

export const SEVERITY = Object.freeze({ DENY: 'deny', WARN: 'warn' });

function describeType(type) {
  if (type === 'array') return 'a list';
  if (type === 'object') return 'null/object';
  return `a ${type}`;
}

function describeProblems(problems) {
  return problems
    .map(
      (problem) =>
        `"${problem.key}" should be ${describeType(problem.expected)} but is ${describeType(problem.got)}`,
    )
    .join('; ');
}

const PARAMETER_WARNING_STATE = 'param-problems';

/**
 * Warns ONCE per session about ignored config params, then only logs. A wrong-typed param
 * is a config bug the user should hear about, but not on every tool call.
 */
function surfaceParameterProblems(gate, problems, sessionId) {
  if (problems.length === 0) return;
  const message =
    `Ignored config param(s) for ${gate.configKey} in .ai/config.json (using built-in ` +
    `defaults instead): ${describeProblems(problems)}. Fix the type to have your override apply.`;
  record(DECISIONS.CONFIG, message);
  const state = readSessionState(PARAMETER_WARNING_STATE, sessionId, {});
  if (state[gate.configKey]) return;
  writeSessionState(PARAMETER_WARNING_STATE, sessionId, {
    ...state,
    [gate.configKey]: true,
  });
  warn(gate.configKey, message);
}

function failClosedOrOpen(gate, error) {
  const message = `The gate failed to evaluate: ${error?.message ?? error}.`;
  if (gate.severity === SEVERITY.WARN) {
    warn(gate.configKey, `${message} It only advises, so the action proceeds.`);
  }
  deny(gate.configKey, `${message} It blocks the action for safety.`);
}

/**
 * The scaffolding every gate shares, so a gate file is just its rule. Given a gate's
 * identity and a `check` function, this: reads stdin (allow when unreadable), turns the
 * gate off when the project config disables it (allow), loads the project's params merged
 * over the gate's own defaults (type-checked), and runs `check`. `check` calls `deny`/`warn`
 * to object, or returns to allow. A throw inside `check` is caught and turned into a deny
 * for a `severity: 'deny'` gate (a gate that cannot evaluate must not silently permit) and
 * into a warn for a `severity: 'warn'` gate (an advisory gate must never block).
 *
 * @param {object} gate
 * @param {string} gate.id            registry id
 * @param {string} gate.configKey     the config flag that enables/disables this gate
 * @param {boolean} gate.enabledByDefault  the registry default when config is silent
 * @param {object} [gate.defaultParams]    the gate's built-in params (the readable defaults)
 * @param {'deny'|'warn'} [gate.severity]  what a failure to evaluate turns into (default deny)
 * @param {(context: { rawPayload: string, toolName: string, toolInput: object,
 *                     sessionId: string|null, parameters: object, cwd: string,
 *                     toolResponse: unknown }) => void} check
 */
export async function runGate(gate, check) {
  // Defaults-dump mode: when the CLI spawns a gate with this flag set, the gate prints its
  // own descriptor (id, configKey, default flag and built-in params) and exits — before
  // touching stdin. This lets `init` materialize each gate's defaults into the config it
  // writes, with the gate as the single source of truth (no duplication in the registry).
  if (process.env.CLAUDE_GATES_DUMP_DEFAULTS) {
    process.stdout.write(
      JSON.stringify({
        id: gate.id,
        configKey: gate.configKey,
        enabledByDefault: gate.enabledByDefault,
        severity: gate.severity ?? SEVERITY.DENY,
        defaultParams: gate.defaultParams ?? {},
      }),
    );
    process.exit(0);
  }

  const rawPayload = readHookPayload();
  if (rawPayload === null) allow();

  const cwd = process.cwd();
  if (!isGateEnabled(gate.configKey, gate.enabledByDefault, cwd)) allow();

  const { parameters, problems } = coerceParameters(
    gate.defaultParams ?? {},
    gateParameters(gate.configKey, cwd),
  );
  const toolName = toolNameOf(rawPayload) ?? '';
  const toolInput = toolInputOf(rawPayload);
  const sessionId = sessionIdOf(rawPayload);
  setDecisionContext({
    gateId: gate.id,
    configKey: gate.configKey,
    toolName,
    toolInput,
    sessionId,
    cwd,
  });

  try {
    // `check` may be sync or async; awaiting a non-promise is transparent, so the same
    // scaffolding serves both. Crucially, allow() runs only AFTER the check settles — an
    // async gate that permits early would never block.
    await check({
      rawPayload,
      toolName,
      toolInput,
      sessionId,
      parameters,
      cwd,
      toolResponse: toolResponseOf(rawPayload),
    });
  } catch (error) {
    failClosedOrOpen(gate, error);
  }
  surfaceParameterProblems(gate, problems, sessionId);
  allow();
}

/**
 * The scaffolding for a Stop hook. Same config/params handling as runGate, plus the
 * mandatory loop guard: when Claude Code re-invokes Stop hooks after one already blocked
 * (`stop_hook_active: true`), this allows unconditionally — a session must never hang.
 * `check` calls `block(label, reason)` to keep the turn going, or returns to allow. ANY
 * failure allows: a broken Stop hook is worse than a missed reminder.
 */
export async function runStopHook(gate, check) {
  if (process.env.CLAUDE_GATES_DUMP_DEFAULTS) {
    process.stdout.write(
      JSON.stringify({
        id: gate.id,
        configKey: gate.configKey,
        enabledByDefault: gate.enabledByDefault,
        severity: SEVERITY.WARN,
        defaultParams: gate.defaultParams ?? {},
      }),
    );
    process.exit(0);
  }
  try {
    const rawPayload = readHookPayload();
    if (rawPayload === null) allow();
    const payload = parsePayload(rawPayload);
    if (payload === null || payload.stop_hook_active === true) allow();

    const cwd = process.cwd();
    if (!isGateEnabled(gate.configKey, gate.enabledByDefault, cwd)) allow();
    const { parameters } = coerceParameters(
      gate.defaultParams ?? {},
      gateParameters(gate.configKey, cwd),
    );
    const sessionId = sessionIdOf(rawPayload);
    setDecisionContext({
      gateId: gate.id,
      configKey: gate.configKey,
      toolName: 'Stop',
      toolInput: {},
      sessionId,
      cwd,
    });
    await check({ rawPayload, payload, sessionId, parameters, cwd });
  } catch {
    // A broken Stop hook must never hang the session.
  }
  allow();
}
