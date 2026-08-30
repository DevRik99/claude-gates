import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function newProject({ config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'recurrence-lock-edge-'));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.ai'), { recursive: true });
  if (config) {
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  return project;
}

function runGateIn(project, payload) {
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function exec() {
  return { tool_name: 'Bash', tool_input: { command: 'echo hi' } };
}
function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

// EDGE CASE (BUG): mcp__ide__executeCode is part of TOOL_GROUPS.execution (lib/hook-io.mjs
// line 37-46) and this gate checks TOOL_GROUPS.execution.includes(toolName), so this should
// actually be covered. Verify it is (defensive check — not assumed).
test('OK: mcp__ide__executeCode is covered because it is in TOOL_GROUPS.execution', () => {
  const project = newProject();
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({ classes: [{ class: 'x', occurrences: [1, 2], status: 'open' }] }),
  );
  assert.ok(isDeny(runGateIn(project, { tool_name: 'mcp__ide__executeCode', tool_input: {} })));
});

// FIXED (was BUG): status is now trimmed before lowercasing, so a padded/capitalized status
// like "Closed " (trailing space) is correctly recognized as closed and no longer sticks the
// lock on a legitimately-resolved recurrence. A genuine typo like "closd" must still NOT be
// recognized (no typo-tolerance) and stays open-blocking, as expected.
test('FIXED: a status of "Closed " (capitalized, trailing space) is trimmed and recognized as closed, unblocking the recurrence', () => {
  const project = newProject();
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({ classes: [{ class: 'x', occurrences: [1, 2], status: 'Closed ' }] }),
  );
  assert.equal(runGateIn(project, exec()), null, 'a padded/capitalized "Closed " status must be trimmed and recognized as closed, allowing the tool call through');
});

test('OK: a genuine typo status like "closd" is NOT recognized as closed and stays open-blocking (no typo-tolerance)', () => {
  const project = newProject();
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({ classes: [{ class: 'x', occurrences: [1, 2], status: 'closd' }] }),
  );
  assert.ok(isDeny(runGateIn(project, exec())), 'a typo status must not be silently treated as closed');
});

// FIXED (was BUG): occurrences are now deduplicated (by id/hash, or by value for bare
// scalars) before counting against the threshold. `occurrences: [1, 1]` is the same
// occurrence logged twice (e.g. by a race or a bug in the writer) and must no longer count
// as two distinct occurrences.
test('FIXED: duplicate identical entries in occurrences[] are deduplicated before counting, so [1, 1] does not reach a threshold of 2', () => {
  const project = newProject();
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({ classes: [{ class: 'dup', occurrences: [1, 1], status: 'open' }] }),
  );
  assert.equal(runGateIn(project, exec()), null, 'duplicate occurrence entries must be deduplicated before comparing against thresholdAppearances');
});

// OK: genuinely distinct occurrences (even with the same shape) must still count normally —
// dedup must not under-count real, distinct recurrences.
test('OK: distinct occurrence entries (identified by id) still count toward the threshold normally', () => {
  const project = newProject();
  writeFileSync(
    join(project, '.ai', 'reincidencias.json'),
    JSON.stringify({
      classes: [
        {
          class: 'distinct',
          occurrences: [{ id: 'a' }, { id: 'b' }],
          status: 'open',
        },
      ],
    }),
  );
  assert.ok(isDeny(runGateIn(project, exec())), 'two genuinely distinct occurrences (different ids) must still trip the threshold');
});
