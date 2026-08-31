// Edge audit for autonomous-mode: does it actually stop the agent from "asking" in every
// surface that exists, or only the one tool it names?
//
// State after the MCP-hole fix (toolInGroups + mcp__.* matcher):
//   1. A corrupted / unparseable stdin payload still makes toolNameOf() return '' and the
//      gate allows — kept intentionally: an unidentifiable tool is not a question to block,
//      and autonomous-mode's job is only to stop the ask surfaces. (A blocking security gate
//      makes the opposite choice; that is per-gate, not a shared default.)
//   2. FIXED. The gate now classifies via toolInGroups: native names match case-insensitively
//      and any MCP ask/confirm/elicit surface (mcp__*__ask_*) hits the question signal, so the
//      differently-cased name and the MCP ask tool are now DENIED (tests below).
//   3. Still true and inherent: a plain-prose question (no tool call) is invisible to any
//      PreToolUse hook. This is the residual limitation the gate's own header documents; it
//      is addressed by the injected reminder, not by the matcher.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function projectWithAutonomous(autonomous) {
  const project = mkdtempSync(join(tmpdir(), 'autonomous-edge-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify({
      gates: { autonomousMode: { enabled: Boolean(autonomous) } },
    }),
  );
  return project;
}

function runGateRaw(rawInput, project) {
  const out = execFileSync(process.execPath, [GATE], {
    input: rawInput,
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('BYPASS: corrupted stdin payload (invalid JSON) is ALLOWED even in autonomous mode', () => {
  const project = projectWithAutonomous(true);
  // Not valid JSON at all -> JSON.parse throws inside toolNameOf -> returns null ->
  // runGate coalesces to '' -> '' not in QUESTION_TOOLS -> allow(). This is the tool_name
  // null->'' bypass named in the task brief, exercised end to end via the real binary.
  const result = runGateRaw('{not valid json', project);
  assert.equal(result, null, 'PASA(bug): corrupted payload bypasses the deny');
});

test('BYPASS: payload missing tool_name entirely is ALLOWED even in autonomous mode', () => {
  const project = projectWithAutonomous(true);
  // Valid JSON, but no tool_name/name field. toolNameOf returns payload?.tool_name ??
  // payload?.name ?? '' -> ''. Same bypass, reached via a well-formed but incomplete payload
  // (e.g. a future/unknown hook event shape) rather than malformed JSON.
  const result = runGateRaw(
    JSON.stringify({ tool_input: { questions: [] } }),
    project,
  );
  assert.equal(
    result,
    null,
    'PASA(bug): payload without tool_name bypasses the deny',
  );
});

test('FIXED: a differently-cased tool name ("askuserquestion") is now DENIED', () => {
  const project = projectWithAutonomous(true);
  // toolInGroups matches native names case-insensitively, so a differently-cased spelling
  // can no longer dodge the question block.
  const result = runGateRaw(
    JSON.stringify({ tool_name: 'askuserquestion', tool_input: {} }),
    project,
  );
  assert.ok(isDeny(result), 'case/name variant must now be blocked');
});

test('FIXED: an MCP "ask" tool is now DENIED via the question signal match', () => {
  const project = projectWithAutonomous(true);
  // toolInGroups classifies mcp__* by its action segment; "ask_user_confirmation" hits the
  // question signal, so an MCP-exposed ask/confirm surface is blocked in autonomous mode too.
  const result = runGateRaw(
    JSON.stringify({
      tool_name: 'mcp__some-server__ask_user_confirmation',
      tool_input: { question: 'Proceed?' },
    }),
    project,
  );
  assert.ok(isDeny(result), 'MCP-exposed ask tool must now be blocked');
});

test('control: canonical AskUserQuestion with well-formed payload IS denied (sanity check)', () => {
  const project = projectWithAutonomous(true);
  const result = runGateRaw(
    JSON.stringify({
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'A or B?' }] },
    }),
    project,
  );
  assert.ok(
    isDeny(result),
    'FALLA(ok): the one exact name it knows is still blocked',
  );
});
