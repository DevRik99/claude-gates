// neutral-spanish:allow — fixtures below quote regional markers on purpose.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeny, runGateProcess, write } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

// A notebook is not a text-type file, so the fixture must read as Spanish prose (three or
// more distinct function words) to be scanned at all.
test('NotebookEdit carrying regional Spanish prose is detected', () => {
  const payload = {
    tool_name: 'NotebookEdit',
    tool_input: {
      notebook_path: 'notebook.ipynb',
      cell_id: 'abc',
      new_source: 'vos tenés que revisar esto con la lista de los datos, dale',
      cell_type: 'markdown',
    },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload)));
});

test('write_to_file with regional Spanish content is detected', () => {
  const payload = {
    tool_name: 'write_to_file',
    tool_input: {
      file_path: 'notes.md',
      content: 'che, mirá el laburo que hicimos acá',
    },
  };
  assert.ok(isDeny(runGateProcess(GATE, payload)));
});

test('word boundary prevents false positive on words containing a marker as substring', () => {
  assert.equal(
    runGateProcess(
      GATE,
      write('notes.md', 'Tengo una sospecha sobre estos hermosos resultados.'),
    ),
    null,
  );
});

test('marker "dale" does not fire on a word merely containing it', () => {
  assert.equal(
    runGateProcess(
      GATE,
      write('notes.md', 'Actualiza el dataleer o el dalext.'),
    ),
    null,
  );
});
