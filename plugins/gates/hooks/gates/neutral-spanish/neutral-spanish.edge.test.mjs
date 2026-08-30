import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function runGate(payload, { config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'neutral-spanish-edge-'));
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
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}

// FIXED: extractText() now gates on toolInGroups(toolName, ['write']) and reads through
// writtenContentOf() (lib/hook-io.mjs), which covers NotebookEdit's new_source field.
test('FIXED: NotebookEdit carrying regional Spanish is detected', () => {
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: '/repo/notebook.ipynb',
      cell_id: 'abc',
      new_source: 'vos tenés que revisar esto, dale',
      cell_type: 'markdown',
    },
  };
  assert.ok(isWarn(runGate(payload)), 'gate now detects regional Spanish written via NotebookEdit');
});

// FIXED: write_to_file is recognized by toolInGroups(toolName, ['write']) (native name in
// TOOL_GROUPS.write) and its `content` field is read through writtenContentOf().
test('FIXED: write_to_file with regional Spanish content is detected', () => {
  const payload = {
    tool_name: 'write_to_file',
    tool_input: {
      file_path: '/repo/notes.md',
      content: 'che, mirá el laburo que hicimos acá',
    },
  };
  assert.ok(isWarn(runGate(payload)), 'gate now detects regional Spanish written via write_to_file');
});

// EDGE CASE 3: false-positive check on legitimate neutral words that are substrings-adjacent
// to markers. "sos" (voseo for "you are") is in the marker list; verify a word that merely
// CONTAINS "sos" as a substring (e.g. "sospecha", "hermosos") is NOT flagged, since the
// pattern uses \p{L} boundaries.
test('OK: word boundary prevents false positive on words containing a marker as substring', () => {
  const result = runGate({
    tool_name: 'Write',
    tool_input: { file_path: '/repo/notes.md', content: 'Tengo una sospecha sobre estos hermosos resultados.' },
  });
  assert.equal(result, null, 'false positive: "sos" matched inside sospecha/hermosos');
});

// EDGE CASE 4: "dale" is in the marker list as Rioplatense slang, but is this over-broad?
// "dale" only appears as that exact word — check it correctly fires only for that token,
// not, e.g., as part of "dalear" or similar. This confirms no over-matching regression.
test('OK: marker "dale" does not fire on a word merely containing it', () => {
  const result = runGate({
    tool_name: 'Write',
    tool_input: { file_path: '/repo/notes.md', content: 'Actualiza el dataleer o el dalext.' },
  });
  assert.equal(result, null, 'false positive: "dale" matched inside a longer word');
});
