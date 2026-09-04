import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isWarn, makeProject, runGateProcess } from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function writeTranscript(project, events) {
  const transcriptPath = join(project, 'transcript.jsonl');
  writeFileSync(
    transcriptPath,
    events.map((event) => JSON.stringify(event)).join('\n'),
  );
  return transcriptPath;
}

function humanTurn(text) {
  return { type: 'user', userType: 'external', message: { content: text } };
}

function askQuestion(transcriptPath, question) {
  return {
    tool_name: 'AskUserQuestion',
    transcript_path: transcriptPath,
    tool_input: { questions: [question] },
  };
}

// Known limitation: overlap is generic word overlap, with no notion of WHICH entity the
// action targets (staging vs billing).
test('KNOWN LIMITATION: approving one migration is treated as approval for a migration of a different entity', () => {
  const project = makeProject({ prefix: 'no-reconfirm-edge-' });
  const transcriptPath = writeTranscript(project, [
    humanTurn('go ahead, migrate the staging database schema now'),
  ]);
  const question = {
    header: '',
    question: 'Should I migrate the billing database schema?',
    options: [],
  };
  assert.ok(
    isWarn(
      runGateProcess(GATE, askQuestion(transcriptPath, question), { project }),
    ),
  );
});

// Assertion flipped with the audited behavior: an approval must START with the affirmative,
// so a negated "do not go ahead" is no longer read as approval.
test('a NEGATED approval phrase ("do not go ahead") is not treated as approval', () => {
  const project = makeProject({ prefix: 'no-reconfirm-edge-' });
  const transcriptPath = writeTranscript(project, [
    humanTurn(
      'do not go ahead with migrating the authentication database schema',
    ),
  ]);
  const question = {
    header: 'Migration',
    question: 'Should I migrate the authentication database schema?',
    options: [],
  };
  assert.equal(
    runGateProcess(GATE, askQuestion(transcriptPath, question), { project }),
    null,
  );
});
