// gate-log — the per-project decision log. Every deny, warn and Stop-block a gate emits is
// appended as one JSON line to `<project root>/.ai/gates-log.jsonl`, so a user can later
// reconstruct WHICH gate blocked WHAT action, WHEN, and WHY — the conversation transcript
// is not a reliable record (it is compacted, and a denied tool call shows only the reason).
//
// Self-contained: Node built-ins only. Never throws: a logging failure must never change a
// gate's decision, so every filesystem call is wrapped and any error is swallowed.
//
// ── Line shape ──────────────────────────────────────────────────────────────────────
//   { "ts": ISO-8601, "decision": "deny"|"warn"|"block"|"config",
//     "gate": id, "configKey": key, "tool": toolName, "session": sessionId|null,
//     "summary": short description of the action judged, "reason": the message }
//
// ── Rotation ────────────────────────────────────────────────────────────────────────
// When the file passes MAX_LOG_BYTES it is renamed to `gates-log.1.jsonl` (replacing any
// previous rotation) and a fresh file starts — one bounded generation kept, never unbounded
// growth in a project directory.
//
// ── Opt-out ─────────────────────────────────────────────────────────────────────────
// CLAUDE_GATES_LOG=0 disables writing (tests that assert a gate's output in a scratch
// project do not need a log file appearing next to it).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { projectRootOf } from './config.mjs';

export const LOG_DIRECTORY = '.ai';
export const LOG_FILE = 'gates-log.jsonl';
export const ROTATED_LOG_FILE = 'gates-log.1.jsonl';
const DISABLE_ENV = 'CLAUDE_GATES_LOG';
const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * BYTES_PER_KILOBYTE;
const MAX_LOG_MEGABYTES = 5;
const MAX_LOG_BYTES = MAX_LOG_MEGABYTES * BYTES_PER_MEGABYTE;
const SUMMARY_MAX_LENGTH = 200;
const REASON_MAX_LENGTH = 800;

export const DECISIONS = Object.freeze({
  DENY: 'deny',
  WARN: 'warn',
  BLOCK: 'block',
  CONFIG: 'config',
});

/** The log path for a project root (the file need not exist yet). */
export function logPathFor(projectRoot) {
  return join(projectRoot, LOG_DIRECTORY, LOG_FILE);
}

function truncate(text, max = SUMMARY_MAX_LENGTH) {
  const single = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * A one-line description of the action a tool call was about to perform, across the tool
 * shapes the gates know: a shell command, a written path, a delegation prompt (with its
 * subagent type), or a question. Falls back to the tool name alone.
 */
function firstText(input, keys) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export function summarizeToolInput(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const command = firstText(input, ['command', 'CommandLine']);
  if (command) return truncate(command);
  const path = firstText(input, [
    'file_path',
    'path',
    'target_file',
    'notebook_path',
  ]);
  if (path) return truncate(path);
  const prompt = firstText(input, ['prompt', 'description', 'task']);
  if (prompt) {
    const type = firstText(input, ['subagent_type', 'subagentType']);
    return truncate(type ? `[${type}] ${prompt}` : prompt);
  }
  const question = input.questions?.[0]?.question;
  return truncate(typeof question === 'string' ? question : (toolName ?? ''));
}

function rotateIfLarge(path, directory) {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size < MAX_LOG_BYTES) return;
    renameSync(path, join(directory, ROTATED_LOG_FILE));
  } catch {
    // Rotation is best-effort; a failure just means the file keeps growing this once.
  }
}

/**
 * Appends one decision line. `entry.cwd` (default process.cwd()) locates the project; when
 * no project root is found (no .git / .ai marker) nothing is written — there is no project
 * to attribute the decision to.
 *
 * @param {{ decision: string, gate: string, configKey: string, toolName?: string,
 *           toolInput?: object, summary?: string, reason: string, sessionId?: string|null,
 *           cwd?: string }} entry
 * @returns {boolean} whether a line was written
 */
export function logDecision(entry) {
  if (process.env[DISABLE_ENV] === '0') return false;
  try {
    const root = projectRootOf(entry.cwd ?? process.cwd());
    if (!root) return false;
    const directory = join(root, LOG_DIRECTORY);
    const path = join(directory, LOG_FILE);
    mkdirSync(directory, { recursive: true });
    rotateIfLarge(path, directory);
    const line = {
      ts: new Date().toISOString(),
      decision: entry.decision,
      gate: entry.gate,
      configKey: entry.configKey,
      tool: entry.toolName ?? null,
      session: entry.sessionId ?? null,
      summary:
        entry.summary ?? summarizeToolInput(entry.toolName, entry.toolInput),
      reason: truncate(entry.reason, REASON_MAX_LENGTH),
    };
    appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
