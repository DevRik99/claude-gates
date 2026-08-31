// Edge-case probes for sdd-specs. Previously: (1) an Edit (new_string) bypassed the
// content check the same way as feature-catalog; (2) malformed JSON content failed
// open (parseJsonOrNull -> null -> features=[] -> nothing to check); (3) the catalog
// lookup was relative to process.cwd() only, so a monorepo subpackage's own
// .ai/feature_list.json living outside cwd was invisible to findCatalog. All three are
// now fixed: writtenContentOf()/writtenPathOf() read every field shape, invalid JSON on
// a catalog write now denies (fail-closed) instead of silently allowing, and
// findCatalog also resolves catalogLocations relative to the written file's own
// directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'sdd-specs-edge-'));
  mkdirSync(join(project, '.git'));
  return project;
}

function writeProjectConfig(project, config) {
  mkdirSync(join(project, '.ai'), { recursive: true });
  writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
}

function runGate(project, payload) {
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isDeny(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

function enableGate(project) {
  writeProjectConfig(project, {
    gates: { requireSpecBeforeImplementing: true },
  });
}

test('FIXED: an Edit (new_string) moving a feature to spec_ready with no contract is now detected', () => {
  const project = makeProject();
  enableGate(project);
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  mkdirSync(join(project, '.ai', 'features', 'checkout'), { recursive: true });
  const payload = {
    tool_name: 'Edit',
    tool_input: {
      file_path: join(project, '.ai', 'feature_list.json'),
      old_string: 'x',
      new_string: JSON.stringify({
        features: [{ name: 'checkout', status: 'spec_ready' }],
      }),
    },
  };
  assert.ok(
    isDeny(runGate(project, payload)),
    'writtenContentOf reads new_string and catches the spec_ready-with-no-contract write',
  );
});

test('FIXED: malformed/invalid JSON content on a catalog write now denies (fail-closed)', () => {
  const project = makeProject();
  enableGate(project);
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  mkdirSync(join(project, '.ai', 'features', 'checkout'), { recursive: true });
  const payload = {
    tool_name: 'Write',
    tool_input: {
      file_path: join(project, '.ai', 'feature_list.json'),
      // deliberately invalid JSON (unquoted keys): the gate can no longer verify the
      // spec-contract invariant for this write, so it denies instead of allowing.
      content: '{features: [{name: "checkout", status: "spec_ready"}]}',
    },
  };
  assert.ok(
    isDeny(runGate(project, payload)),
    'malformed JSON targeting the catalog must deny, not fail open',
  );
});

test('FIXED: a catalog living outside process.cwd() is now found via the written path', () => {
  const project = makeProject();
  enableGate(project);
  // The catalog lives under sub/.ai/feature_list.json, not the project root's .ai/ --
  // findCatalog now also resolves catalogLocations relative to dirname(writtenPath).
  mkdirSync(join(project, 'sub', '.ai', 'features', 'checkout'), {
    recursive: true,
  });
  writeFileSync(
    join(project, 'sub', '.ai', 'feature_list.json'),
    JSON.stringify({ features: [{ name: 'checkout', status: 'spec_ready' }] }),
  );
  const payload = {
    tool_name: 'Write',
    tool_input: {
      file_path: join(project, 'sub', '.ai', 'feature_list.json'),
      content: JSON.stringify({
        features: [{ name: 'checkout', status: 'spec_ready' }],
      }),
    },
  };
  assert.ok(
    isDeny(runGate(project, payload)),
    'a subpackage catalog reached via its own written path must now be inspected',
  );
});

test('OK: the equivalent Write-tool payload at the project root IS caught (control)', () => {
  const project = makeProject();
  enableGate(project);
  writeFileSync(
    join(project, '.ai', 'feature_list.json'),
    JSON.stringify({ features: [] }),
  );
  const payload = {
    tool_name: 'Write',
    tool_input: {
      file_path: join(project, '.ai', 'feature_list.json'),
      content: JSON.stringify({
        features: [{ name: 'checkout', status: 'spec_ready' }],
      }),
    },
  };
  assert.ok(isDeny(runGate(project, payload)), 'control failed');
});
