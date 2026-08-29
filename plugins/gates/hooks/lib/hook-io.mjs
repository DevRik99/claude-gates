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

/** The `matcher` string for a hooks.json entry: `Bash|Edit|Write`, or '' when empty. */
export function matcherFor(groups) {
  return toolNamesFor(groups).join('|');
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
      gate.id,
      `The gate failed to evaluate and blocks the action for safety: ${error?.message ?? error}.`,
    );
  }
  allow();
}
