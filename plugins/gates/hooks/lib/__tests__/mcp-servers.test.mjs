// ATTACK MATRIX — lib/mcp-servers.mjs, the judge of whether a demanded MCP server exists
// boundary: COVERED — the exact three states the answer can come from: no source, a source
//   naming the server, a source omitting it
// invalid-input: COVERED — mcpServers holding a string instead of an object, a null
//   candidate list and an empty candidate name
// missing-empty: COVERED — a home with nothing in it, an empty mcpServers block, null and
//   empty candidates
// invalid-state: COVERED — a source that exists yet declares nothing: known with zero
//   names, which must answer "not installed" rather than "cannot tell"
// dependency-failure: COVERED — an unreadable config file leaves the machine unknown
//   instead of throwing
// idempotency-order: COVERED — the same query twice across two different homes, so a stale
//   cache cannot answer for the wrong machine
// invariant: COVERED — an undeclared server is NEVER reported as installed, because a gate
//   that demands it would leave no remedy the agent can follow
// security: COVERED — a shorter declared name must not bypass the containment rule
// mutations-killed: undeclared returning false -> true (the no-exit loop returns), `name.includes(wanted)` -> `wanted.includes(name)`, cache key dropping root -> home alone, keysOf guard removed -> Object.keys over a string, normalizeServerName removed -> "Engram AI" stops matching

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONTEXT7_SERVERS,
  ENGRAM_SERVERS,
  declaredMcpNames,
  mcpServerAvailable,
} from '../mcp-servers.mjs';

function machine({ userConfig, projectConfig, plugins } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  const root = mkdtempSync(join(tmpdir(), 'mcp-root-'));
  if (userConfig !== undefined)
    writeFileSync(
      join(home, '.claude.json'),
      typeof userConfig === 'string' ? userConfig : JSON.stringify(userConfig),
    );
  if (projectConfig !== undefined)
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(projectConfig));
  if (plugins !== undefined) {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(plugins),
    );
  }
  return { home, root };
}

const ask = (candidates, { home, root }) =>
  mcpServerAvailable(candidates, root, { home });

test('INVARIANT: an undeclared server is never reported as installed', () => {
  const { home, root } = machine();
  assert.equal(mcpServerAvailable(ENGRAM_SERVERS, root, { home }), false);
  assert.equal(declaredMcpNames(root, { home }).known, false);
});

test('a name whose punctuation the tool namespace rewrites still matches', () => {
  const spaced = machine({ userConfig: { mcpServers: { 'Engram AI': {} } } });
  assert.equal(ask(['engram_ai'], spaced), true);
});

test('boundary: the exact edge between a server omitted and a server declared', () => {
  const omitted = machine({ userConfig: { mcpServers: { figma: {} } } });
  assert.equal(ask(ENGRAM_SERVERS, omitted), false);
  assert.equal(ask(CONTEXT7_SERVERS, omitted), false);

  const declared = machine({
    userConfig: { mcpServers: { figma: {}, engram: {} } },
  });
  assert.equal(ask(ENGRAM_SERVERS, declared), true);
});

test('invalid-state: a source that exists yet declares nothing is still knowledge', () => {
  const { home, root } = machine({ userConfig: { mcpServers: {} } });
  const declared = declaredMcpNames(root, { home });
  assert.equal(declared.known, true);
  assert.deepEqual(declared.names, []);
  assert.equal(mcpServerAvailable(ENGRAM_SERVERS, root, { home }), false);
});

test('the server is found in any of the three sources', () => {
  assert.equal(
    ask(
      ENGRAM_SERVERS,
      machine({ userConfig: { mcpServers: { engram: {} } } }),
    ),
    true,
  );
  assert.equal(
    ask(
      CONTEXT7_SERVERS,
      machine({
        userConfig: { mcpServers: {} },
        projectConfig: { mcpServers: { context7: {} } },
      }),
    ),
    true,
  );
  assert.equal(
    ask(
      ENGRAM_SERVERS,
      machine({
        userConfig: { mcpServers: {} },
        plugins: { plugins: { 'engram@marketplace': [] } },
      }),
    ),
    true,
  );
});

test('security: a shorter declared name must not bypass the containment rule', () => {
  const wider = machine({
    userConfig: { mcpServers: { 'engram-viewer': {} } },
  });
  assert.equal(ask(ENGRAM_SERVERS, wider), true);

  const shorter = machine({ userConfig: { mcpServers: { gram: {} } } });
  assert.equal(ask(ENGRAM_SERVERS, shorter), false);
});

test('dependency-failure: an unreadable config does not throw, it reads as absent', () => {
  const corrupt = machine({ userConfig: '{ not json' });
  assert.equal(
    declaredMcpNames(corrupt.root, { home: corrupt.home }).known,
    false,
  );
  assert.equal(ask(ENGRAM_SERVERS, corrupt), false);
});

test('invalid-input and missing values answer false instead of crashing', () => {
  const wrongShape = machine({ userConfig: { mcpServers: 'engram' } });
  assert.equal(ask(ENGRAM_SERVERS, wrongShape), false);

  const declared = machine({ userConfig: { mcpServers: { engram: {} } } });
  for (const candidates of [null, [], ['']])
    assert.equal(ask(candidates, declared), false);
});

test('idempotency: asking twice across two homes does not reuse a stale answer', () => {
  const withEngram = machine({ userConfig: { mcpServers: { engram: {} } } });
  const without = machine({ userConfig: { mcpServers: { figma: {} } } });
  assert.equal(ask(ENGRAM_SERVERS, withEngram), true);
  assert.equal(ask(ENGRAM_SERVERS, without), false);
  assert.equal(ask(ENGRAM_SERVERS, withEngram), true);
});
