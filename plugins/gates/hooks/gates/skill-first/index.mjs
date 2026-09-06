// skill-first — the READ half of the capability pair, and the deterministic counterpart to
// capability-map. capability-map tells the model what it has; nothing made the model act on
// it. Its catalog is injected at UserPromptSubmit, throttled, carrying an advisory line —
// so a turn that writes forty files gets one soft reminder at the top and none at the
// moment each action is actually taken. This gate closes that half: before an action that
// a listed skill plausibly covers, it requires evidence the question was asked.
//
// The pair mirrors reuse-before-build/tool-map: one shared definition of the catalog
// (lib/capabilities.mjs), a write half that records, a read half that judges.
//
// Deliberately narrow, because relevance here is a lexical heuristic and a false deny is
// expensive. It only speaks when ALL of these hold:
//   · the action carries enough text to judge (`minTextChars`);
//   · a skill is plausibly relevant — the action NAMES it, or shares `minTokenOverlap`
//     distinctive tokens with its description;
//   · the session shows no sign the question was already asked.
// Everything else is the silent path.
//
// Three ways to clear it, all cheap and none requiring filesystem exploration:
//   1. invoke the relevant skill (the Skill tool; recorded by this gate's track.mjs);
//   2. state the decision in the content/prompt ("using the dataviz skill", "no skill
//      covers this") — the same escape-hatch shape reuse-before-build uses;
//   3. turn the gate off for the project.
//
// Off by default: it rests on a heuristic, and a gate that guesses must be opted into.

import {
  entriesForKind,
  hasSkillAuditEvidence,
  relevantCapabilities,
} from '../../lib/capabilities.mjs';
import { projectRootOf } from '../../lib/config.mjs';
import {
  delegationPromptOf,
  deny,
  runGate,
  shellCommandOf,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';
import { readSessionState } from '../../lib/session-state.mjs';

export const GATE_ID = 'skill-first';
export const CONFIG_KEY = 'requireSkillCheckBeforeActing';

// How many of the shared tokens the deny message shows: enough to make the match
// legible, few enough to keep the line short.
const SHOWN_SHARED_TOKENS = 4;

const DEFAULT_PARAMS = {
  kinds: ['skills'],
  minTokenOverlap: 3,
  maxMatches: 3,
  minTextChars: 40,
  extraSkillsDirs: [],
  extraAgentsDirs: [],
  extraCommandsDirs: [],
};

/** The text that describes what this action is about to do, per tool shape. */
function actionTextOf(toolName, toolInput) {
  if (toolInGroups(toolName, ['delegation']))
    return delegationPromptOf(toolInput);
  if (toolInGroups(toolName, ['write'])) {
    return `${writtenPathOf(toolInput)}\n${writtenContentOf(toolInput)}`;
  }
  if (toolInGroups(toolName, ['shell'])) return shellCommandOf(toolInput);
  return '';
}

function catalogEntries(root, parameters) {
  const entries = [];
  for (const kind of parameters.kinds) {
    entries.push(...entriesForKind(String(kind), root, parameters));
  }
  return entries;
}

/** Skills this session already loaded, as recorded by track.mjs. */
function invokedSkills(sessionId, cwd) {
  const state = readSessionState(GATE_ID, sessionId, {}, { cwd });
  const names = Array.isArray(state.skillsInvoked) ? state.skillsInvoked : [];
  return new Set(names.map((name) => String(name).toLowerCase()));
}

function describeMatch(match) {
  if (match.named) return `${match.name} (named in this action)`;
  const shared = match.shared.slice(0, SHOWN_SHARED_TOKENS).join(', ');
  return `${match.name} (matches on: ${shared})`;
}

function denyMessage(matches, isDelegation) {
  const target = isDelegation ? "this delegation's prompt" : 'the content';
  return (
    `Blocked: ${matches.length} available skill(s) look relevant to this action, and nothing ` +
    `shows they were considered:\n  ${matches.map(describeMatch).join('\n  ')}\n` +
    'Pick ONE, then retry the same action:\n' +
    `  1. The skill covers this — load it (the Skill tool) and follow it instead of improvising.\n` +
    `  2. It does not fit — add ONE line to ${target} saying so, e.g. "no skill covers this", ` +
    'or name the one you are following, e.g. "using the <name> skill".\n' +
    'No filesystem exploration is required: the catalog was read for you, and the audit is ' +
    'one sentence.'
  );
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: false,
    defaultParams: DEFAULT_PARAMS,
  },
  ({ toolName, toolInput, sessionId, parameters, cwd }) => {
    const isDelegation = toolInGroups(toolName, ['delegation']);
    if (!isDelegation && !toolInGroups(toolName, ['execution'])) return;

    const text = actionTextOf(toolName, toolInput);
    if (text.trim().length < parameters.minTextChars) return;
    if (hasSkillAuditEvidence(text)) return;

    const root = projectRootOf(cwd) ?? cwd;
    const matches = relevantCapabilities(
      text,
      catalogEntries(root, parameters),
      {
        minTokenOverlap: parameters.minTokenOverlap,
        maxMatches: parameters.maxMatches,
      },
    );
    if (matches.length === 0) return;

    const invoked = invokedSkills(sessionId, cwd);
    if (matches.some((match) => invoked.has(match.name.toLowerCase()))) return;

    deny(CONFIG_KEY, denyMessage(matches, isDelegation));
  },
);
