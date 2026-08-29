import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function newProject({ config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'no-reconfirm-'));
  mkdirSync(join(project, '.git'));
  if (config) {
    mkdirSync(join(project, '.ai'));
    writeFileSync(join(project, '.ai', 'config.json'), JSON.stringify(config));
  }
  return project;
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

function askQuestion(transcriptPath, question) {
  return {
    tool_name: 'AskUserQuestion',
    transcript_path: transcriptPath,
    tool_input: { questions: [question] },
  };
}

function runGateIn(project, payload) {
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

function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}

test('warns when re-asking a topic the user already approved', () => {
  const project = newProject();
  const transcriptPath = writeTranscript(project, [
    humanTurn('go ahead, migrate the authentication database schema now'),
  ]);
  const question = {
    header: 'Migration',
    question: 'Should I migrate the authentication database schema?',
    options: [],
  };
  assert.ok(isWarn(runGateIn(project, askQuestion(transcriptPath, question))));
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
  const transcriptPath = writeTranscript(project, [
    humanTurn('go ahead, migrate the authentication database schema now'),
  ]);
  const question = {
    header: 'Migration',
    question: 'Should I migrate the authentication database schema?',
    options: [],
  };
  assert.equal(runGateIn(project, askQuestion(transcriptPath, question)), null);
});

test('degrades to allow when transcript_path is missing or unreadable', () => {
  const project = newProject();
  const question = {
    header: 'Migration',
    question: 'Should I migrate now?',
    options: [],
  };
  assert.equal(
    runGateIn(project, {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [question] },
    }),
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
