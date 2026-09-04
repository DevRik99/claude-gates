// no-reconfirm — asking again what the user already approved gets a reminder to proceed.
// Advisory only. An approval is a human turn that STARTS with an affirmative; a turn that
// merely contains "proceed" ("how should I proceed?") is a question, not an approval. Only
// the tail of the transcript is read: an approval given hundreds of turns ago is stale.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { runGate, warn, toolInGroups } from '../../lib/hook-io.mjs';

const GATE_ID = 'no-reconfirm';
const CONFIG_KEY = 'requireNoReconfirmOfApproved';

const DEFAULT_OVERLAP_THRESHOLD = 0.34;
const MIN_SHARED_WORDS = 2;
const MIN_SIGNIFICANT_WORD_LENGTH = 5;
const QUESTION_PREVIEW_LENGTH = 100;
const APPROVING_TURN_PREVIEW_LENGTH = 140;
const TRANSCRIPT_TAIL_LINES = 400;
const KIB = 1024;
const TRANSCRIPT_TAIL_BYTES = KIB * KIB;

const AFFIRMATIVES = [
  'yes',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  'go ahead',
  'proceed',
  'approved',
  'do it',
  's[ií]',
  'de acuerdo',
  'adelante',
  'procede',
  'hazlo',
  'correcto',
  'confirmo',
  'aprobado',
];
const APPROVAL_START_PATTERN = new RegExp(
  String.raw`^\s*(?:${AFFIRMATIVES.join('|')})(?![\p{L}\p{N}_])`,
  'iu',
);

const STOP_WORDS = new Set([
  'about',
  'above',
  'after',
  'again',
  'against',
  'before',
  'being',
  'below',
  'between',
  'could',
  'during',
  'having',
  'other',
  'people',
  'should',
  'system',
  'their',
  'there',
  'these',
  'those',
  'through',
  'under',
  'until',
  'where',
  'which',
  'while',
  'would',
]);

function isHumanTurn(event) {
  if (event?.type !== 'user' || event?.userType !== 'external') return false;
  const content = event?.message?.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content))
    return content.every((block) => block?.type === 'text');
  return false;
}

function textOf(event) {
  const content = event.message.content;
  if (typeof content === 'string') return content;
  return content.map((block) => block.text || '').join(' ');
}

function tailLinesOf(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const { size } = fstatSync(descriptor);
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < size) lines.shift();
    return lines.slice(-TRANSCRIPT_TAIL_LINES);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function humanTurnsFrom(transcriptPath) {
  const lines = tailLinesOf(transcriptPath);
  if (lines === null) return null;
  const turns = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (isHumanTurn(event)) turns.push(textOf(event));
  }
  return turns;
}

function significantWords(text) {
  const normalized = String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const words = normalized.match(/[a-z]+/g) || [];
  return new Set(
    words.filter(
      (word) =>
        word.length >= MIN_SIGNIFICANT_WORD_LENGTH && !STOP_WORDS.has(word),
    ),
  );
}

function optionsOf(question) {
  return Array.isArray(question?.options) ? question.options : [];
}

function topicOfQuestion(question) {
  const header = String(question?.header || '');
  const body = String(question?.question || '');
  const optionLabels = optionsOf(question)
    .map((option) => String(option?.label || ''))
    .join(' ');
  return `${header} ${body} ${optionLabels}`;
}

function turnThatAlreadyApprovedThisTopic(
  humanTurns,
  question,
  overlapThreshold,
) {
  const topicWords = significantWords(topicOfQuestion(question));
  if (topicWords.size === 0) return null;

  for (const turn of humanTurns) {
    if (!APPROVAL_START_PATTERN.test(turn)) continue;
    const turnWords = significantWords(turn);
    let shared = 0;
    for (const word of topicWords) {
      if (turnWords.has(word)) shared++;
    }
    const fraction = shared / topicWords.size;
    if (shared >= MIN_SHARED_WORDS && fraction >= overlapThreshold) return turn;
  }
  return null;
}

function transcriptPathOf(rawPayload) {
  try {
    return JSON.parse(rawPayload)?.transcript_path;
  } catch {
    return null;
  }
}

function questionsOf(toolInput) {
  if (Array.isArray(toolInput?.questions)) {
    return toolInput.questions.filter(
      (question) => question && typeof question === 'object',
    );
  }
  if (typeof toolInput?.question === 'string')
    return [{ question: toolInput.question }];
  return [];
}

function noticeFor(question, approvingTurn) {
  const questionPreview = String(question?.question || '').slice(
    0,
    QUESTION_PREVIEW_LENGTH,
  );
  const approvingTurnPreview = approvingTurn
    .replace(/\s+/g, ' ')
    .slice(0, APPROVING_TURN_PREVIEW_LENGTH);
  return `Question "${questionPreview}" shares its topic with a turn where the user already gave explicit approval: "${approvingTurnPreview}". If it is the same decision, do not re-ask — proceed.`;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    severity: 'warn',
    defaultParams: {
      overlapThreshold: DEFAULT_OVERLAP_THRESHOLD,
    },
  },
  ({ toolName, toolInput, parameters, rawPayload }) => {
    if (!toolInGroups(toolName, ['question'])) return;

    const questions = questionsOf(toolInput);
    if (questions.length === 0) return;

    const transcriptPath = transcriptPathOf(rawPayload);
    if (typeof transcriptPath !== 'string' || !transcriptPath) return;

    const humanTurns = humanTurnsFrom(transcriptPath);
    if (!humanTurns || humanTurns.length === 0) return;

    const notices = questions
      .map((question) => ({
        question,
        approvingTurn: turnThatAlreadyApprovedThisTopic(
          humanTurns,
          question,
          parameters.overlapThreshold,
        ),
      }))
      .filter((entry) => entry.approvingTurn)
      .map((entry) => noticeFor(entry.question, entry.approvingTurn));
    if (notices.length === 0) return;
    warn(CONFIG_KEY, notices.join('\n\n'));
  },
);
