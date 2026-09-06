// testing.mjs — the harness every gate test uses to run a gate exactly as Claude Code does:
// as its own process, payload on stdin, inside a scratch project so config and state lookups
// are isolated. One copy here instead of the same twenty lines pasted into every test file.
//
// Not imported by any gate at runtime; Node built-ins only.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A scratch project: a temp directory with a `.git` marker (so it is a project root), an
 * optional `.ai/config.json`, and any extra files (`{ 'relative/path': content }`).
 */
export function makeProject({
  prefix = 'gate-',
  git = true,
  config,
  files = {},
} = {}) {
  const project = mkdtempSync(join(tmpdir(), prefix));
  if (git) mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'), { recursive: true });
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  for (const [relative, content] of Object.entries(files)) {
    const path = join(project, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return project;
}

/**
 * Runs a gate script against a payload and returns its parsed JSON output, or null when
 * the gate allowed silently. `project` (or a fresh one built from `config`/`files`) is the
 * cwd and the HOME, so global config never leaks in. The decision log is disabled unless
 * `log` is true. Throws when the gate process exits non-zero (a crash is a test failure).
 */
export function runGateProcess(
  gatePath,
  payload,
  {
    project,
    config,
    files,
    cwd,
    environment = {},
    log = false,
    timeout = 15000,
  } = {},
) {
  const root = project ?? makeProject({ config, files });
  const options = {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: cwd ?? root,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CLAUDE_GATES_LOG: log ? '1' : '0',
      ...environment,
    },
    timeout,
  };
  try {
    const out = execFileSync(process.execPath, [gatePath], options);
    const trimmed = out.trim();
    return trimmed ? JSON.parse(trimmed) : null;
  } catch (error) {
    if (error.status === 2) {
      const stderr = String(error.stderr ?? '').trim();
      const stdout = String(error.stdout ?? '').trim();
      const source = stderr || stdout;
      return source ? JSON.parse(source) : null;
    }
    throw error;
  }
}

/** 'deny' | 'warn' | 'block' | null from a gate's parsed output. */
export function decisionOf(result) {
  if (!result) return null;
  if (result.hookSpecificOutput?.permissionDecision === 'deny') return 'deny';
  if (result.decision === 'block') return 'block';
  if (typeof result.hookSpecificOutput?.additionalContext === 'string')
    return 'warn';
  return null;
}

export function isDeny(result) {
  return decisionOf(result) === 'deny';
}
export function isWarn(result) {
  return decisionOf(result) === 'warn';
}
export function isBlock(result) {
  return decisionOf(result) === 'block';
}

/** The deny reason / warn context / block reason text, or ''. */
export function messageOf(result) {
  return (
    result?.hookSpecificOutput?.permissionDecisionReason ??
    result?.hookSpecificOutput?.additionalContext ??
    result?.reason ??
    ''
  );
}

// ── Payload builders ────────────────────────────────────────────────────────────────
export function bash(command, extra = {}) {
  return { tool_name: 'Bash', tool_input: { command, ...extra } };
}
export function write(filePath, content = '', extra = {}) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: filePath, content, ...extra },
  };
}
export function edit(filePath, newString, oldString = '', extra = {}) {
  return {
    tool_name: 'Edit',
    tool_input: {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      ...extra,
    },
  };
}
export function delegate(prompt, subagentType, extra = {}) {
  const input = { prompt, ...extra };
  if (subagentType !== undefined) input.subagent_type = subagentType;
  return { tool_name: 'Agent', tool_input: input };
}
export function ask(question, options = [], extra = {}) {
  return {
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question, options, ...extra }] },
  };
}
export function withSession(payload, sessionId) {
  return { ...payload, session_id: sessionId };
}
