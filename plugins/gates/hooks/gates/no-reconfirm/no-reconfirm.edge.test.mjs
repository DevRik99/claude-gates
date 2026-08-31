import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

function newProject({ config } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'no-reconfirm-edge-'));
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
    env: { ...process.env, HOME: project, USERPROFILE: project },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function isWarn(result) {
  return result?.hookSpecificOutput?.additionalContext !== undefined;
}

// EDGE CASE (BUG, confirmed via manual calculation before writing this test): the overlap
// check has no notion of WHICH entity the action targets — it only counts shared
// significant (>=5 char) words between the approving turn and the new question's topic
// text (header+question+option labels). Approving "migrate the STAGING database schema"
// shares 3 of 4 topic words (migrate/database/schema) with an unrelated question about
// migrating the BILLING database schema — a materially different target — and clears both
// MIN_SHARED_WORDS (2) and the default overlapThreshold (0.34): shared=3, fraction=0.75.
test('BUG: approving one migration is treated as approval for an unrelated migration of a different entity (staging vs billing)', () => {
  const project = newProject();
  const transcriptPath = writeTranscript(project, [
    humanTurn('go ahead, migrate the staging database schema now'),
  ]);
  const question = {
    header: '',
    question: 'Should I migrate the billing database schema?',
    options: [],
  };
  const result = runGateIn(project, askQuestion(transcriptPath, question));
  // Documents the false positive: the gate claims this was "already approved" even though
  // the user approved a migration of a DIFFERENT database (staging, not billing).
  assert.ok(
    isWarn(result),
    'expected the (buggy) false-positive warn to fire: no entity/target check, only generic word overlap',
  );
});

// EDGE CASE (BUG candidate): false negative via negation. The APPROVAL_PATTERN matches
// literal phrases like "go ahead" / "do it" without checking for a preceding negation.
// "don't go ahead" or "no, don't do it yet" still matches the raw pattern.
test('BUG: a NEGATED approval phrase ("do not go ahead") is still treated as approval', () => {
  const project = newProject();
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
  const result = runGateIn(project, askQuestion(transcriptPath, question));
  assert.ok(
    isWarn(result),
    'expected the (buggy) warn to fire even though the user said NOT to go ahead — APPROVAL_PATTERN has no negation check',
  );
});
