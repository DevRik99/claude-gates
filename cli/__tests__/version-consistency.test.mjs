// Version coherence guard. This exists because of a real incident: the npm package was
// bumped to 0.1.3 and published, but plugin.json / marketplace.json stayed at 0.1.0. Claude
// Code versions a plugin by its plugin.json/marketplace version, so a machine that already
// had 0.1.0 cached NEVER updated the code on reinstall — it ran the old, pre-migration gates
// while the freshly written config.json said 0.1.3. The gates looked "enabled but broken".
//
// The rule this enforces: the npm package version, both plugin.json versions, and every
// marketplace.json plugin entry must be the SAME string. Bump them together, every release.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8').replace(/^﻿/, ''));
}

test('npm, both plugin.json, and every marketplace entry share one version', () => {
  const versions = {
    'package.json': readJson('package.json').version,
    'plugins/gates/.claude-plugin/plugin.json': readJson(
      'plugins/gates/.claude-plugin/plugin.json',
    ).version,
    'plugins/tasks/.claude-plugin/plugin.json': readJson(
      'plugins/tasks/.claude-plugin/plugin.json',
    ).version,
  };
  for (const plugin of readJson('.claude-plugin/marketplace.json').plugins) {
    versions[`marketplace.json:${plugin.name}`] = plugin.version;
  }

  const distinct = [...new Set(Object.values(versions))];
  assert.equal(
    distinct.length,
    1,
    `all versions must match; found ${JSON.stringify(versions)}. ` +
      'A plugin.json/marketplace version behind the npm version means Claude Code keeps ' +
      'serving the OLD cached plugin code on reinstall. Bump them together.',
  );
});
