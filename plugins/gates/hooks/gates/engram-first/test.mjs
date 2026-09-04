import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isBlock,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  withSession,
} from '../../lib/testing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'index.mjs');
const TRACK = join(HERE, 'track.mjs');
const STOP = join(HERE, 'stop.mjs');

let counter = 0;
function freshSession() {
  counter += 1;
  return `engram-first-test-${process.pid}-${counter}`;
}

function webSearch(query) {
  return { tool_name: 'WebSearch', tool_input: { query } };
}
function context7(libraryName) {
  return {
    tool_name: 'mcp__context7__resolve-library-id',
    tool_input: { libraryName },
  };
}
function memSearch(query, response = 'Found 2 memories') {
  return {
    tool_name: 'mcp__engram__mem_search',
    tool_input: { query },
    tool_response: response,
  };
}
function memSave(title) {
  return {
    tool_name: 'mcp__engram__mem_save',
    tool_input: { title },
    tool_response: 'Memory saved',
  };
}

test('denies WebSearch when no mem_search happened in the session', () => {
  const project = makeProject();
  const session = freshSession();
  const result = runGateProcess(
    GATE,
    withSession(webSearch('zod refine'), session),
    {
      project,
    },
  );
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /mem_search/);
});

test('denies context7 lookups before engram, like any research tool', () => {
  const project = makeProject();
  const result = runGateProcess(
    GATE,
    withSession(context7('zod'), freshSession()),
    {
      project,
    },
  );
  assert.ok(isDeny(result));
});

test('allows research once a mem_search was tracked for the session', () => {
  const project = makeProject();
  const session = freshSession();
  runGateProcess(TRACK, withSession(memSearch('zod refine'), session), {
    project,
  });
  const result = runGateProcess(
    GATE,
    withSession(webSearch('zod refine'), session),
    {
      project,
    },
  );
  assert.equal(result, null);
});

test('engram tools themselves are never research: mem_search is allowed first', () => {
  const project = makeProject();
  const result = runGateProcess(
    GATE,
    withSession(memSearch('anything'), freshSession()),
    { project },
  );
  assert.equal(result, null);
});

test('Stop is blocked when research happened and nothing was saved afterwards', () => {
  const project = makeProject();
  const session = freshSession();
  runGateProcess(TRACK, withSession(memSearch('x'), session), { project });
  runGateProcess(TRACK, withSession(webSearch('x'), session), { project });
  const stop = runGateProcess(STOP, { session_id: session }, { project });
  assert.ok(isBlock(stop));
  assert.match(messageOf(stop), /mem_save/);
});

test('Stop is allowed after a mem_save that follows the research', () => {
  const project = makeProject();
  const session = freshSession();
  runGateProcess(TRACK, withSession(memSearch('x'), session), { project });
  runGateProcess(TRACK, withSession(webSearch('x'), session), { project });
  runGateProcess(TRACK, withSession(memSave('what x is'), session), {
    project,
  });
  const stop = runGateProcess(STOP, { session_id: session }, { project });
  assert.equal(stop, null);
});

test('Stop never blocks twice: stop_hook_active allows', () => {
  const project = makeProject();
  const session = freshSession();
  runGateProcess(TRACK, withSession(memSearch('x'), session), { project });
  runGateProcess(TRACK, withSession(webSearch('x'), session), { project });
  const stop = runGateProcess(
    STOP,
    { session_id: session, stop_hook_active: true },
    { project },
  );
  assert.equal(stop, null);
});

test('disabled by config: research is allowed without engram', () => {
  const project = makeProject({
    config: { gates: { requireEngramBeforeResearch: false } },
  });
  const result = runGateProcess(
    GATE,
    withSession(webSearch('x'), freshSession()),
    {
      project,
    },
  );
  assert.equal(result, null);
});
