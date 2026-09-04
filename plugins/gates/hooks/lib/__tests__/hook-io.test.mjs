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
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
  delegationPromptOf,
  shellWrittenPaths,
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

test('matcherFor joins native tool names with a pipe and always appends the mcp__.* clause', () => {
  // The trailing `mcp__.*` makes Claude Code route EVERY MCP tool call to the hook, so the
  // gate can classify it at runtime with toolInGroups. Without it, the hook is never even
  // invoked for an MCP tool — the deepest layer of the MCP blind spot.
  assert.equal(matcherFor(['question']), 'AskUserQuestion|mcp__.*');
  assert.equal(matcherFor(['shell']), 'Bash|run_command|PowerShell|mcp__.*');
});

test('matcherFor still matches MCP tools even for an empty native group set', () => {
  // An empty group means "no native names", but MCP tools must still reach the hook.
  assert.equal(matcherFor([]), 'mcp__.*');
});

test('toolInGroups matches native names exactly and case-insensitively', () => {
  assert.equal(toolInGroups('Write', ['write']), true);
  assert.equal(toolInGroups('write', ['write']), true); // case-insensitive
  assert.equal(toolInGroups('AskUserQuestion', ['question']), true);
  assert.equal(toolInGroups('Bash', ['write']), false); // wrong group
  assert.equal(toolInGroups('', ['write']), false); // empty tool name
});

test('toolInGroups classifies MCP tools by their action segment', () => {
  assert.equal(toolInGroups('mcp__filesystem__write_file', ['write']), true);
  assert.equal(toolInGroups('mcp__fs__edit_file', ['write']), true);
  assert.equal(toolInGroups('mcp__shell__exec', ['shell']), true);
  assert.equal(
    toolInGroups('mcp__x__ask_user_confirmation', ['question']),
    true,
  );
  assert.equal(
    toolInGroups('mcp__orchestrator__spawn_agent', ['delegation']),
    true,
  );
  // A read-only MCP tool must NOT match a write/shell group.
  assert.equal(toolInGroups('mcp__fs__read_file', ['write', 'shell']), false);
  // Malformed mcp name (no action segment) does not match.
  assert.equal(toolInGroups('mcp__server', ['write']), false);
});

test('writtenContentOf reads content across native and MCP field shapes', () => {
  assert.equal(writtenContentOf({ content: 'a' }), 'a'); // Write
  assert.equal(writtenContentOf({ new_string: 'b' }), 'b'); // Edit
  assert.equal(writtenContentOf({ new_source: 'c' }), 'c'); // NotebookEdit
  assert.equal(writtenContentOf({ new_content: 'd' }), 'd'); // replace_file_content
  assert.equal(writtenContentOf({ text: 'e' }), 'e'); // an MCP shape
  assert.equal(
    writtenContentOf({ edits: [{ new_string: 'x' }, { new_string: 'y' }] }),
    'x\ny',
  ); // MultiEdit
  assert.equal(writtenContentOf({}), '');
  assert.equal(writtenContentOf(null), '');
});

test('writtenPathOf reads the target path across field shapes', () => {
  assert.equal(writtenPathOf({ file_path: 'a.js' }), 'a.js');
  assert.equal(writtenPathOf({ path: 'b.js' }), 'b.js');
  assert.equal(writtenPathOf({ notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert.equal(writtenPathOf({}), '');
});

test('delegationPromptOf reads the brief across field shapes', () => {
  assert.equal(delegationPromptOf({ prompt: 'a' }), 'a');
  assert.equal(delegationPromptOf({ description: 'b' }), 'b'); // Task
  assert.equal(delegationPromptOf({ instructions: 'c' }), 'c'); // an MCP shape
  assert.equal(delegationPromptOf({}), '');
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

test('shellWrittenPaths extracts paths a shell command creates', () => {
  assert.deepEqual(shellWrittenPaths('printf x > basura.txt'), ['basura.txt']);
  assert.deepEqual(shellWrittenPaths('echo hi >> log.txt'), ['log.txt']);
  assert.deepEqual(shellWrittenPaths('touch nuevo.js'), ['nuevo.js']);
  assert.deepEqual(shellWrittenPaths('tee out.txt'), ['out.txt']);
  // creates nothing -> empty
  assert.deepEqual(shellWrittenPaths('git status'), []);
  assert.deepEqual(shellWrittenPaths('cat archivo.txt'), []);
  // a dynamically built path is NOT extracted (documented limitation)
  assert.deepEqual(shellWrittenPaths('printf x > "$f"'), []);
});

test('shellWrittenPaths captures the DESTINATION of cp/mv/install, not the source', () => {
  // The old proxy captured the first argument (the source), so `cp registry.json /tmp/x`
  // was judged as a write to registry.json. The destination is what gets created.
  assert.deepEqual(shellWrittenPaths('cp a.txt b.txt'), ['b.txt']);
  assert.deepEqual(shellWrittenPaths('mv old.js new.js'), ['new.js']);
  assert.deepEqual(shellWrittenPaths('install script.sh /usr/local/bin/'), [
    '/usr/local/bin/',
  ]);
  // still caught after a command separator, not only at the very start of the string
  assert.deepEqual(shellWrittenPaths('cd repo && cp a.txt b.txt'), ['b.txt']);
});

test('shellWrittenPaths sees no-space redirects, quoted targets with spaces, mkdir, clone, curl and PowerShell writers', () => {
  assert.deepEqual(shellWrittenPaths('echo hi>orphan.txt'), ['orphan.txt']);
  assert.deepEqual(shellWrittenPaths('echo x > "my file.txt"'), [
    'my file.txt',
  ]);
  assert.deepEqual(shellWrittenPaths('mkdir newdir other'), [
    'newdir',
    'other',
  ]);
  assert.deepEqual(shellWrittenPaths('git clone https://x/y/repo.git'), [
    'repo',
  ]);
  assert.deepEqual(shellWrittenPaths('git clone https://x/y/repo.git target'), [
    'target',
  ]);
  assert.deepEqual(shellWrittenPaths('curl -s https://x -o dump.json'), [
    'dump.json',
  ]);
  assert.deepEqual(shellWrittenPaths('Set-Content -Path .env "x"'), ['.env']);
  assert.deepEqual(shellWrittenPaths('"a" | Out-File out.txt'), ['out.txt']);
  assert.deepEqual(shellWrittenPaths('New-Item -Path repo/new.txt'), [
    'repo/new.txt',
  ]);
  // a dynamic target is still skipped
  assert.deepEqual(shellWrittenPaths('echo x > "$OUT"'), []);
});

test('shellWrittenPaths does NOT mistake a package manager subcommand for the "install" utility (regression: npm install <pkg> was misread as creating a root file named <pkg>)', () => {
  assert.deepEqual(shellWrittenPaths('npm install -D daisyui'), []);
  assert.deepEqual(
    shellWrittenPaths('npm install --save-dev daisyui tailwindcss'),
    [],
  );
  assert.deepEqual(shellWrittenPaths('pip install requests'), []);
  assert.deepEqual(shellWrittenPaths('yarn install'), []);
  assert.deepEqual(shellWrittenPaths('pnpm install'), []);
});
