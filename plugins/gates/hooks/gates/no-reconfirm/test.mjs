import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isDeny,
  isWarn,
  makeProject,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function newProject({ config } = {}) {
  return makeProject({ prefix: 'no-reconfirm-', config });
}

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

function askQuestion(transcriptPath, question, toolName = 'AskUserQuestion') {
  return {
    tool_name: toolName,
    transcript_path: transcriptPath,
    tool_input: { questions: [question] },
  };
}

function runGateIn(project, payload) {
  return runGateProcess(GATE, payload, { project });
}

const MIGRATION_QUESTION = {
  header: 'Migration',
  question: 'Should I migrate the authentication database schema?',
  options: [],
};
const APPROVAL = 'go ahead, migrate the authentication database schema now';

test('warns when re-asking a topic the user already approved', () => {
  const project = newProject();
  const transcriptPath = writeTranscript(project, [humanTurn(APPROVAL)]);
  assert.ok(
    isWarn(runGateIn(project, askQuestion(transcriptPath, MIGRATION_QUESTION))),
  );
});

test('allows a genuinely new question with no prior approval overlap', () => {
  const project = newProject();
  const transcriptPath = writeTranscript(project, [humanTurn('hello there')]);
  const question = {
    header: 'Deploy',
    question: 'Should I deploy to production now?',
    options: [],
  };
  assert.equal(runGateIn(project, askQuestion(transcriptPath, question)), null);
});

test('disabled by config: the gate does not run', () => {
  const project = newProject({
    config: { gates: { requireNoReconfirmOfApproved: false } },
  });
  const transcriptPath = writeTranscript(project, [humanTurn(APPROVAL)]);
  assert.equal(
    runGateIn(project, askQuestion(transcriptPath, MIGRATION_QUESTION)),
    null,
  );
});

test('degrades to allow when transcript_path is missing or unreadable', () => {
  const project = newProject();
  assert.equal(
    runGateIn(project, {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [MIGRATION_QUESTION] },
    }),
    null,
  );
  assert.equal(
    runGateIn(
      project,
      askQuestion(join(project, 'missing.jsonl'), MIGRATION_QUESTION),
    ),
    null,
  );
});

test('overlapThreshold override changes sensitivity', () => {
  const project = newProject({
    config: {
      gates: {
        requireNoReconfirmOfApproved: { enabled: true, overlapThreshold: 0.99 },
      },
    },
  });
  const transcriptPath = writeTranscript(project, [
    humanTurn('go ahead, migrate the authentication schema'),
  ]);
  const question = {
    header: 'Migration',
    question:
      'Should I migrate the authentication database schema now with backups?',
    options: [],
  };
  assert.equal(runGateIn(project, askQuestion(transcriptPath, question)), null);
});

// ── Approval = a turn that STARTS with an affirmative ───────────────────────────────
test('"how should I proceed?" is a question, not an approval', () => {
  const project = newProject();
  const transcriptPath = writeTranscript(project, [
    humanTurn(
      'how should I proceed with the authentication database schema migration?',
    ),
  ]);
  assert.equal(
    runGateIn(project, askQuestion(transcriptPath, MIGRATION_QUESTION)),
    null,
  );
});

test('Spanish affirmatives at the start of the turn count as approval', () => {
  const project = newProject();
  for (const opening of ['sí', 'de acuerdo', 'adelante', 'hazlo', 'ok']) {
    const transcriptPath = writeTranscript(project, [
      humanTurn(`${opening}, migrate the authentication database schema`),
    ]);
    assert.ok(
      isWarn(
        runGateIn(project, askQuestion(transcriptPath, MIGRATION_QUESTION)),
      ),
      opening,
    );
  }
});

test('an affirmative that is only a prefix of the first word is not an approval', () => {
  const project = newProject();
  const transcriptPath = writeTranscript(project, [
    humanTurn('okra, migrate the authentication database schema'),
  ]);
  assert.equal(
    runGateIn(project, askQuestion(transcriptPath, MIGRATION_QUESTION)),
    null,
  );
});

// ── Robustness ──────────────────────────────────────────────────────────────────────
test('a non-array options field is treated as no options and never denies', () => {
  const project = newProject();
  const transcriptPath = writeTranscript(project, [humanTurn(APPROVAL)]);
  const result = runGateIn(
    project,
    askQuestion(transcriptPath, { ...MIGRATION_QUESTION, options: {} }),
  );
  assert.ok(!isDeny(result));
  assert.ok(isWarn(result));
});

test('a null overlapThreshold falls back to the default instead of matching everything', () => {
  const project = newProject({
    config: {
      gates: {
        requireNoReconfirmOfApproved: { enabled: true, overlapThreshold: null },
      },
    },
  });
  const transcriptPath = writeTranscript(project, [
    humanTurn('yes, please rename the readme headings'),
  ]);
  const result = runGateIn(
    project,
    askQuestion(transcriptPath, MIGRATION_QUESTION),
  );
  assert.ok(!isDeny(result));
  assert.doesNotMatch(
    result?.hookSpecificOutput?.additionalContext ?? '',
    /already gave explicit approval/,
  );
});

test('an MCP ask tool is inspected like AskUserQuestion', () => {
  const project = newProject();
  const transcriptPath = writeTranscript(project, [humanTurn(APPROVAL)]);
  assert.ok(
    isWarn(
      runGateIn(
        project,
        askQuestion(transcriptPath, MIGRATION_QUESTION, 'mcp__ui__ask_user'),
      ),
    ),
  );
});

test('only the last 400 lines of the transcript are consulted', () => {
  const project = newProject();
  const filler = Array.from({ length: 450 }, (_, index) =>
    humanTurn(`filler turn number ${index}`),
  );
  const transcriptPath = writeTranscript(project, [
    humanTurn(APPROVAL),
    ...filler,
  ]);
  assert.equal(
    runGateIn(project, askQuestion(transcriptPath, MIGRATION_QUESTION)),
    null,
  );
});
