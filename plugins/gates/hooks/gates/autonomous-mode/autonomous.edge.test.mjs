// Does autonomous-mode stop the agent from "asking" on every surface, or only the one tool
// it names? A plain-prose question (no tool call) stays invisible to any PreToolUse hook;
// that residual case is what stop.mjs addresses.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const ON = { config: { gates: { autonomousMode: { enabled: true } } } };

function runGateRaw(rawInput) {
  return runGateProcess(GATE, rawInput, ON);
}

// An unidentifiable tool is not a question to block: autonomous-mode only stops the ask
// surfaces, so an unparseable payload allows (a security gate makes the opposite choice).
test('corrupted stdin payload (invalid JSON) is ALLOWED even in autonomous mode', () => {
  assert.equal(runGateRaw('{not valid json'), null);
});

test('payload missing tool_name entirely is ALLOWED even in autonomous mode', () => {
  assert.equal(
    runGateRaw(JSON.stringify({ tool_input: { questions: [] } })),
    null,
  );
});

test('a differently-cased tool name ("askuserquestion") is DENIED', () => {
  assert.ok(
    isDeny(
      runGateRaw(
        JSON.stringify({ tool_name: 'askuserquestion', tool_input: {} }),
      ),
    ),
  );
});

test('an MCP "ask" tool is DENIED via the question signal match', () => {
  assert.ok(
    isDeny(
      runGateRaw(
        JSON.stringify({
          tool_name: 'mcp__some-server__ask_user_confirmation',
          tool_input: { question: 'Proceed?' },
        }),
      ),
    ),
  );
});

test('control: canonical AskUserQuestion with well-formed payload IS denied', () => {
  assert.ok(
    isDeny(
      runGateRaw(
        JSON.stringify({
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'A or B?' }] },
        }),
      ),
    ),
  );
});
