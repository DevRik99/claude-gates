import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'audit-before-build-edge-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  const out = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return { out: out.trim() ? JSON.parse(out.trim()) : null, project };
}

function delegate(prompt) {
  return { tool_name: 'Agent', tool_input: { prompt } };
}
function write(filePath, content) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
}
const ENABLE = { config: { gates: { requireAuditBeforeBuilding: true } } };

// EDGE CASE (BUG): AUDIT_EVIDENCE_PATTERN is a bare substring/regex test over the WHOLE
// delegation prompt with no proximity/ordering requirement relative to the tool-creation
// intent. An unrelated, earlier sentence that happens to say "no existing tool" anywhere
// in a long prompt satisfies the audit-evidence check even when it has nothing to do with
// the actual tool being created, so a prompt can smuggle past the gate by mentioning
// boilerplate audit language irrelevantly.
test('BUG: false negative — audit language elsewhere in the prompt, unrelated to the new tool, satisfies the check', () => {
  const prompt =
    'Context: earlier we confirmed no existing tool handles our deploy pipeline. ' +
    'Now, unrelated task: create a new script that scrapes user passwords from logs.';
  const { out } = runGate(delegate(prompt), ENABLE);
  assert.equal(
    out,
    null,
    'gate allows because AUDIT_EVIDENCE_PATTERN matched irrelevant boilerplate anywhere in the prompt',
  );
});

// EDGE CASE (BUG): INLINE_JUSTIFICATION_PATTERN for a direct Write is similarly a bare
// substring test over the whole file content. Any comment anywhere in the file containing
// the word "justification:" (even quoting/describing the concept, not actually justifying
// THIS file) passes.
test('BUG: false negative — the word "justification:" appearing in an unrelated docstring satisfies the check for any new tool file', () => {
  const content = [
    '// This module documents how other files use the phrase justification: <reason> in',
    '// their headers, as an example of our commenting convention.',
    'export function run() {}',
  ].join('\n');
  const { out } = runGate(
    write('/repo/scripts/new-thing.mjs', content),
    ENABLE,
  );
  assert.equal(
    out,
    null,
    'gate allows because the literal string "justification:" appears anywhere, regardless of whether it actually justifies this file',
  );
});

// EDGE CASE: confirm the "editing an existing file" exemption (checkWrite, index.mjs line
// 56-58) can be trivially satisfied by ANY tool call whose file_path happens to already
// exist on disk from an unrelated prior write within the same directory — verifying this
// is intentional per the comment, not a further bug, but documenting the boundary.
test('OK (documented, not a new bug): pre-creating an empty file at the target path bypasses audit entirely on the next edit', () => {
  const { project } = runGate(delegate('noop'), ENABLE); // just to get an isolated project dir
  const targetPath = join(project, 'scripts', 'sneaky.mjs');
  mkdirSync(join(project, 'scripts'), { recursive: true });
  writeFileSync(targetPath, ''); // pre-create empty file outside the gate's view
  const out2 = execFileSync(process.execPath, [GATE], {
    input: JSON.stringify(write(targetPath, 'export function run() {}')),
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  assert.equal(
    out2.trim() ? JSON.parse(out2.trim()) : null,
    null,
    'existsSync(rawPath) exemption means pre-touching the file first defeats the whole gate',
  );
});
