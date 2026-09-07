// The block edits a file the user owns, so the tests that matter most are the ones proving
// it never touches anything outside its markers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLOCK_END,
  BLOCK_START,
  mergeBlock,
  renderBlock,
} from '../claude-md.mjs';
import { loadRegistry } from '../registry.mjs';

const registry = loadRegistry();

test('the block lists only the gates that are actually on', () => {
  const block = renderBlock(registry, {
    blockDestructiveShellCommands: true,
    requireSkillCheckBeforeActing: false,
  });
  assert.match(block, /bash-commands/);
  assert.doesNotMatch(block, /skill-first/);
});

test('a gate with no config entry follows the registry default', () => {
  const onByDefault = registry.families
    .flatMap((family) => family.gates)
    .find((gate) => gate.default);
  const offByDefault = registry.families
    .flatMap((family) => family.gates)
    .find((gate) => !gate.default);

  const block = renderBlock(registry, {});
  assert.ok(
    block.includes(onByDefault.id),
    `${onByDefault.id} should be listed`,
  );
  assert.ok(
    !block.includes(`\`${offByDefault.id}\``),
    `${offByDefault.id} should not be listed`,
  );
});

test('an all-off project gets a block that says so instead of a bare heading', () => {
  const gates = {};
  for (const family of registry.families)
    for (const gate of family.gates) gates[gate.configKey] = false;
  assert.match(renderBlock(registry, gates), /No gates are enabled/);
});

test('the text comes from the registry, so it cannot drift from the gates', () => {
  const gate = registry.families[0].gates[0];
  const block = renderBlock(registry, { [gate.configKey]: true });
  assert.ok(
    block.includes(gate.description.slice(0, 40)),
    "the description must be the registry's, not a second copy",
  );
});

test('a first run appends without disturbing what the user wrote', () => {
  const existing = '# My project\n\nSome notes I care about.\n';
  const merged = mergeBlock(existing, renderBlock(registry, {}));
  assert.ok(merged.startsWith('# My project'));
  assert.match(merged, /Some notes I care about\./);
  assert.ok(merged.includes(BLOCK_START) && merged.includes(BLOCK_END));
});

test('a second run replaces the block and leaves both sides byte for byte', () => {
  const before = '# Head\n\nkeep me\n\n';
  const after = '\n\n## Tail\n\nkeep me too\n';
  const first = mergeBlock(
    `${before}${BLOCK_START}\nstale content\n${BLOCK_END}${after}`,
    renderBlock(registry, { blockDestructiveShellCommands: true }),
  );

  assert.doesNotMatch(first, /stale content/);
  assert.ok(
    first.startsWith(before),
    'everything before the block must survive',
  );
  assert.ok(first.endsWith(after), 'everything after the block must survive');

  const second = mergeBlock(first, renderBlock(registry, {}));
  assert.equal(
    (second.match(new RegExp(BLOCK_START, 'g')) ?? []).length,
    1,
    'repeated runs must not stack blocks',
  );
});

test('an empty file gets the block alone, with no leading blank lines', () => {
  const merged = mergeBlock('', renderBlock(registry, {}));
  assert.ok(merged.startsWith(BLOCK_START));
});

test('a truncated marker pair is treated as absent rather than corrupting the file', () => {
  const existing = `# Head\n\n${BLOCK_START}\nhalf a block, no end marker\n`;
  const merged = mergeBlock(existing, renderBlock(registry, {}));
  assert.match(merged, /half a block, no end marker/);
  assert.ok(merged.includes(BLOCK_END));
});
