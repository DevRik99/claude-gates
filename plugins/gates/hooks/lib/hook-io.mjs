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
//   3. Reading a deny/warn decision out of a gate's own JSON output shape.

import { readFileSync } from 'node:fs';
import { gateParameters, isGateEnabled } from './config.mjs';

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
    'NotebookEdit',
    'write_to_file',
    'replace_file_content',
  ],
  shell: ['Bash', 'run_command'],
  delegation: ['Agent', 'Task', 'invoke_subagent'],
  question: ['AskUserQuestion'],
  // The main agent materializing a change directly, whatever the surface.
  execution: [
    'Write',
    'Edit',
    'NotebookEdit',
    'write_to_file',
    'replace_file_content',
    'Bash',
    'run_command',
    'mcp__ide__executeCode',
  ],
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
});

const MCP_TOOL_PREFIX = 'mcp__';
// mcp__<server>__<action>: prefix + server + action, three underscore-delimited segments.
const MCP_TOOL_NAME_SEGMENT_COUNT = 3;

/** The action segment of an MCP tool name (`mcp__server__do_thing` -> `do_thing`), or ''. */
function mcpActionSegment(toolName) {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return '';
  const parts = toolName.split('__');
  return parts.length >= MCP_TOOL_NAME_SEGMENT_COUNT
    ? parts.slice(2).join('__')
    : '';
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
  const lowered = toolName.toLowerCase();
  if (native.some((name) => name.toLowerCase() === lowered)) return true;
  const action = mcpActionSegment(toolName);
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
  return String(direct);
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
  return String(path);
}

// Shell forms that CREATE or write a file at a named path, so a gate protecting a path can
// see a `printf ... > basura.txt` the same way it sees a Write. Each pattern captures the
// target path. Conservative by design: it over-detects (a gate then finds the path benign)
// rather than under-detects (a silent hole). It does NOT resolve variables, command
// substitution, or subshells — a path built dynamically (`> "$f"`) is not extracted; that
// limitation is documented on the gates that use this, the honest boundary of a regex.
const SHELL_WRITE_PATTERNS = [
  // redirection: `> file`, `>> file`, `1> file`, `&> file` (not `2>` alone — stderr)
  /(?:^|\s|;|&&|\|\|)(?:\d*|&)>>?\s*(['"]?)([^\s'"|;&<>]+)\1/g,
  // touch / tee target(s)
  /\b(?:touch|tee)\s+(?:-\S+\s+)*(['"]?)([^\s'"|;&<>]+)\1/g,
  // cp / mv / install destination is the LAST path; capture the first arg after the command
  // as a cheap proxy (over-detects the source too, which is acceptable — a gate re-checks).
  /\b(?:cp|mv|install)\s+(?:-\S+\s+)*(['"]?)([^\s'"|;&<>]+)\1/g,
];

/**
 * Every filesystem path a shell command appears to create or write to (redirections, touch,
 * tee, cp/mv destinations). Returns a de-duplicated list, empty when none is found. A gate
 * that protects paths should check these IN ADDITION to writtenPathOf, or a shell redirection
 * slips past it (the exact hole that let `printf x > basura.txt` evade root-whitelist while a
 * Write to the same path was blocked).
 */
export function shellWrittenPaths(command) {
  const text = String(command ?? '');
  const found = new Set();
  for (const pattern of SHELL_WRITE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const path = match[2];
      // Skip a dynamically built target (a variable/substitution): we cannot resolve `$f`,
      // `${x}` or `$(…)` to a real path, and guessing would only add false positives. This is
      // the documented limitation — the write-tool surface, which carries a concrete path,
      // stays the reliable one.
      if (path && !/[$`]/.test(path)) found.add(path);
    }
  }
  return [...found];
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
  return String(prompt);
}

/** Reads the raw hook payload from stdin. Returns null when stdin cannot be read. */
export function readHookPayload() {
  try {
    return readFileSync(STDIN_FILE_DESCRIPTOR, 'utf8');
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
  try {
    const payload = JSON.parse(rawPayload);
    return payload?.tool_name ?? payload?.name ?? '';
  } catch {
    return null;
  }
}

/** The session id inside a raw payload, or null when absent/unparseable. */
export function sessionIdOf(rawPayload) {
  try {
    return JSON.parse(rawPayload)?.session_id ?? null;
  } catch {
    return null;
  }
}

/** The tool input object inside a raw payload, or {} when absent/unparseable. */
export function toolInputOf(rawPayload) {
  try {
    const payload = JSON.parse(rawPayload);
    return payload?.tool_input ?? payload?.input ?? {};
  } catch {
    return {};
  }
}

const PRE_TOOL_USE_EVENT = 'PreToolUse';

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
 * `label` is the gate id, prefixed to every message so a block names its source.
 */
export function deny(label, reason) {
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

/**
 * The scaffolding every gate shares, so a gate file is just its rule. Given a gate's
 * identity and a `check` function, this: reads stdin (allow when unreadable), turns the
 * gate off when the project config disables it (allow), loads the project's params merged
 * over the gate's own defaults, and runs `check`. `check` calls `deny`/`warn` to object,
 * or returns to allow. A throw inside `check` is caught and turned into a deny — a gate
 * that cannot evaluate must not silently permit.
 *
 * @param {object} gate
 * @param {string} gate.id            registry id, used as the message label
 * @param {string} gate.configKey     the config flag that enables/disables this gate
 * @param {boolean} gate.enabledByDefault  the registry default when config is silent
 * @param {object} [gate.defaultParams]    the gate's built-in params (the readable defaults)
 * @param {(context: { rawPayload: string, toolName: string, toolInput: object,
 *                     sessionId: string|null, parameters: object }) => void} check
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
        defaultParams: gate.defaultParams ?? {},
      }),
    );
    process.exit(0);
  }

  const rawPayload = readHookPayload();
  if (rawPayload === null) allow();

  if (!isGateEnabled(gate.configKey, gate.enabledByDefault, process.cwd()))
    allow();

  const declared = gateParameters(gate.configKey, process.cwd());
  const parameters = { ...(gate.defaultParams ?? {}), ...declared };

  try {
    // `check` may be sync or async; awaiting a non-promise is transparent, so the same
    // scaffolding serves both. Crucially, allow() runs only AFTER the check settles — an
    // async gate that permits early would never block.
    await check({
      rawPayload,
      toolName: toolNameOf(rawPayload) ?? '',
      toolInput: toolInputOf(rawPayload),
      sessionId: sessionIdOf(rawPayload),
      parameters,
    });
  } catch (error) {
    deny(
      gate.configKey,
      `The gate failed to evaluate and blocks the action for safety: ${error?.message ?? error}.`,
    );
  }
  allow();
}
