import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// Runs the gate as a child process inside a temp project (with .git so config/root resolve).
// The gate is off by default, so config enables it unless a test overrides that. An optional
// tool map is seeded. Returns parsed stdout or null when it allowed.
function runGate(payload, { config, toolMap } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'reuse-before-build-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'));
  const effectiveConfig = config ?? {
    gates: { requireReuseCheckBeforeBuilding: true },
  };
  writeFileSync(
    join(project, '.ai', 'config.json'),
    JSON.stringify(effectiveConfig),
  );
  if (toolMap) {
    writeFileSync(
      join(project, '.ai', 'tool-map.json'),
      JSON.stringify(toolMap),
    );
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    // Isolate from the user's real global config: point homedir() at the temp
    // project so the global-config fallback finds nothing (registry default).
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function writeTool(content) {
  return {
    tool_name: 'Write',
    tool_input: { file_path: 'scripts/csv-parser.mjs', content },
  };
}
function delegate(prompt) {
  return { tool_name: 'Agent', tool_input: { prompt } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('denies building a new tool without an audit', () => {
  assert.ok(isDeny(runGate(writeTool('export function parse() {}'))));
  assert.ok(
    isDeny(
      runGate(delegate('Please write a new script that parses CSV files.')),
    ),
  );
});

test('allows when the text declares an audit was done', () => {
  assert.equal(
    runGate(
      writeTool('// Justification: no existing tool covers this.\nexport {}'),
    ),
    null,
  );
  assert.equal(
    runGate(
      delegate('Write a new script for CSV — I audited and nothing does this.'),
    ),
    null,
  );
});

test('allows when the need is already recorded in the tool map', () => {
  const toolMap = { tools: [{ path: 'scripts/csv-parser.mjs', audit: 'x' }] };
  assert.equal(runGate(writeTool('export {}'), { toolMap }), null);
});

test('ignores non-tool writes (a plain markdown file)', () => {
  assert.equal(
    runGate({
      tool_name: 'Write',
      tool_input: { file_path: 'docs/readme.md', content: 'hello' },
    }),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(writeTool('export {}'), {
      config: { gates: { requireReuseCheckBeforeBuilding: false } },
    }),
    null,
  );
});
