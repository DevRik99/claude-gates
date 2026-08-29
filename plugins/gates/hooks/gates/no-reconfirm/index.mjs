import { readFileSync, existsSync } from 'node:fs';
import { runGate, warn, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'no-reconfirm';
const CONFIG_KEY = 'requireNoReconfirmOfApproved';

const DEFAULT_OVERLAP_THRESHOLD = 0.34;
const MIN_SHARED_WORDS = 2;
const MIN_SIGNIFICANT_WORD_LENGTH = 5;
const QUESTION_PREVIEW_LENGTH = 100;
const APPROVING_TURN_PREVIEW_LENGTH = 140;

function wordBoundary(alternatives) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(${alternatives})(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

const APPROVAL_PATTERN = wordBoundary(
  'go ahead|approved|i approve|authorized|proceed|do it|confirmed|i confirm|' +
    'sounds good,? do it|yes,? (do it|go ahead|proceed)|ok,? (do it|go ahead|proceed)',
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

function humanTurnsFrom(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const turns = [];
  for (const line of raw.split('\n')) {
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

function topicOfQuestion(question) {
  const header = String(question?.header || '');
  const body = String(question?.question || '');
  const optionLabels = (question?.options || [])
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
    if (!APPROVAL_PATTERN.test(turn)) continue;

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

function collectReconfirmationNotices(questions, humanTurns, overlapThreshold) {
  const notices = [];
  for (const question of questions) {
    const approvingTurn = turnThatAlreadyApprovedThisTopic(
      humanTurns,
      question,
      overlapThreshold,
    );
    if (approvingTurn) notices.push(noticeFor(question, approvingTurn));
  }
  return notices;
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      overlapThreshold: DEFAULT_OVERLAP_THRESHOLD,
    },
  },
  ({ toolName, toolInput, parameters, rawPayload }) => {
    if (!TOOL_GROUPS.question.includes(toolName)) return;

    const questions = Array.isArray(toolInput?.questions)
      ? toolInput.questions
      : [];
    if (questions.length === 0) return;

    const transcriptPath = transcriptPathOf(rawPayload);
    if (!transcriptPath) return;

    const humanTurns = humanTurnsFrom(transcriptPath);
    if (humanTurns === null || humanTurns.length === 0) return; // no readable transcript: cannot verify

    const notices = collectReconfirmationNotices(
      questions,
      humanTurns,
      parameters.overlapThreshold,
    );
    if (notices.length === 0) return;
    warn(GATE_ID, notices.join('\n\n'));
  },
);
