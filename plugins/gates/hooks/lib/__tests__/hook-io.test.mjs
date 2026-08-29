import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  toolNamesFor,
  matcherFor,
  toolNameOf,
  sessionIdOf,
  toolInputOf,
} from '../hook-io.mjs';

// deny/warn/allow/runGate call process.exit and cannot be invoked in-process without
// killing the test runner. They are exercised here as a child process instead; each
// gate's own tests additionally cover runGate's wiring through its real check function.

test('toolNamesFor expands a single group', () => {
  assert.deepEqual(toolNamesFor(['question']), ['AskUserQuestion']);
});

test('toolNamesFor expands multiple groups and de-duplicates overlapping names', () => {
  const names = toolNamesFor(['write', 'execution']);
  // 'execution' repeats every 'write' tool plus Bash/run_command/mcp__ide__executeCode.
  assert.equal(names.filter((name) => name === 'Write').length, 1);
  assert.ok(names.includes('Write'));
  assert.ok(names.includes('Bash'));
  assert.ok(names.includes('mcp__ide__executeCode'));
});

test('toolNamesFor returns an empty list for an empty group set', () => {
  assert.deepEqual(toolNamesFor([]), []);
});

test('toolNamesFor ignores an unknown group name', () => {
  assert.deepEqual(toolNamesFor(['not-a-real-group']), []);
});

test('matcherFor joins tool names with a pipe', () => {
  assert.equal(matcherFor(['question']), 'AskUserQuestion');
  assert.equal(matcherFor(['shell']), 'Bash|run_command');
});

test('matcherFor returns an empty string for an empty group set', () => {
  assert.equal(matcherFor([]), '');
});

test('toolNameOf reads tool_name, falls back to name, defaults to empty string', () => {
  assert.equal(toolNameOf(JSON.stringify({ tool_name: 'Bash' })), 'Bash');
  assert.equal(toolNameOf(JSON.stringify({ name: 'Edit' })), 'Edit');
  assert.equal(
    toolNameOf(JSON.stringify({ tool_name: 'Bash', name: 'Edit' })),
    'Bash',
  );
  assert.equal(toolNameOf(JSON.stringify({})), '');
});

test('toolNameOf returns null for unparseable payloads', () => {
  assert.equal(toolNameOf('{not json'), null);
  assert.equal(toolNameOf(undefined), null);
});

test('sessionIdOf reads session_id or returns null when absent/unparseable', () => {
  assert.equal(sessionIdOf(JSON.stringify({ session_id: 'abc123' })), 'abc123');
  assert.equal(sessionIdOf(JSON.stringify({})), null);
  assert.equal(sessionIdOf('{not json'), null);
});

test('toolInputOf reads tool_input, falls back to input, defaults to {}', () => {
  assert.deepEqual(
    toolInputOf(JSON.stringify({ tool_input: { command: 'ls' } })),
    { command: 'ls' },
  );
  assert.deepEqual(toolInputOf(JSON.stringify({ input: { file: 'a' } })), {
    file: 'a',
  });
  assert.deepEqual(
    toolInputOf(JSON.stringify({ tool_input: { a: 1 }, input: { b: 2 } })),
    { a: 1 },
  );
  assert.deepEqual(toolInputOf(JSON.stringify({})), {});
});

test('toolInputOf returns {} for unparseable payloads', () => {
  assert.deepEqual(toolInputOf('{not json'), {});
  assert.deepEqual(toolInputOf(undefined), {});
});

const hookIoModuleUrl = pathToFileURL(
  new URL('../hook-io.mjs', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  ),
).href;

/** Runs `body` (a callback expression referencing `mod`) in a child process after
 *  dynamically importing hook-io.mjs there, so process.exit-calling exports can be
 *  exercised without killing the test runner. */
function runInChildProcess(body, execOptions) {
  const script = `import('${hookIoModuleUrl}').then((mod) => { ${body} });`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    ...execOptions,
  });
}

test('readHookPayload reads whatever is piped on stdin, including empty input', () => {
  const output = runInChildProcess(
    'process.stdout.write(JSON.stringify(mod.readHookPayload()))',
    { input: '{"tool_name":"Bash"}' },
  );
  assert.equal(output, JSON.stringify('{"tool_name":"Bash"}'));

  const emptyOutput = runInChildProcess(
    'process.stdout.write(JSON.stringify(mod.readHookPayload()))',
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // With no stdin available, readFileSync(0) resolves to an empty string rather than
  // throwing on this platform, so readHookPayload returns '' — not null. The null
  // path (an unreadable fd 0) is exercised indirectly by every gate's own tests via
  // runGate, since forcing an EBADF/EAGAIN on fd 0 portably from node:test is not
  // reliable across platforms.
  assert.equal(emptyOutput, JSON.stringify(''));
});

test('deny writes a permissionDecision:deny hookSpecificOutput and exits 0', () => {
  const output = runInChildProcess("mod.deny('my-gate', 'because reasons')", {
    input: '',
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(
    parsed.hookSpecificOutput.permissionDecisionReason,
    '[my-gate] because reasons',
  );
});

test('warn writes additionalContext and exits 0', () => {
  const output = runInChildProcess("mod.warn('my-gate', 'consider this')", {
    input: '',
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(
    parsed.hookSpecificOutput.additionalContext,
    '[my-gate] consider this',
  );
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined);
});

test('allow exits 0 with no stdout', () => {
  const output = runInChildProcess('mod.allow()', { input: '' });
  assert.equal(output, '');
});
