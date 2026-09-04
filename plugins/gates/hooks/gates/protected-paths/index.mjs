// protected-paths — denies a write, a shell redirection or a mutating shell command that
// targets a protected path (.env files, lockfiles, the harness's own hooks). Deliberate
// semantics: a fragment without a slash names a file by its exact basename (`.env` is not
// `.env.example`), a fragment ending in a slash names a contiguous directory sequence
// (`.claude/hooks/` is not `src/hooks/`). Only the command segment that RUNS a mutating
// command is judged, so `npm install; cat .env` reads and is allowed. A path built from a
// variable is not resolved.

import { posix } from 'node:path';
import {
  compileRegexList,
  deny,
  runGate,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
  writtenPathOf,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'protected-paths';
const CONFIG_KEY = 'blockWritesToProtectedPaths';

const DEFAULT_PROTECTED_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.claude/hooks/',
];

// Regex sources matched at the start of a command segment. A command is mutating when its
// ARGUMENTS name the protected path; redirections are covered separately by shellWrittenPaths.
const DEFAULT_MUTATING_COMMANDS = [
  'touch',
  'rm',
  'cp',
  'mv',
  String.raw`sed\s+(?:-i|--in-place)`,
  'tee',
  'install',
  'chmod',
  'chown',
  'truncate',
  'unlink',
  'dd',
  String.raw`perl\s+-\w*i`,
  String.raw`git\s+checkout\s+--`,
  String.raw`git\s+restore`,
  'Set-Content',
  'Add-Content',
  'Out-File',
  'Remove-Item',
  'del',
  'erase',
  'Copy-Item',
  'Move-Item',
  'New-Item',
  'Rename-Item',
  'copy',
  'move',
  'ren',
];

// ── Path matching ───────────────────────────────────────────────────────────────────
function pathSegmentsOf(path) {
  const normalized = posix.normalize(String(path).replace(/\\/g, '/'));
  return normalized.toLowerCase().split('/').filter(Boolean);
}

function fragmentRule(fragment) {
  const segments = pathSegmentsOf(fragment);
  return {
    fragment,
    segments,
    anchoredAtEnd: !String(fragment).endsWith('/'),
  };
}

function segmentsMatchAt(pathSegments, ruleSegments, offset) {
  return ruleSegments.every(
    (segment, index) => pathSegments[offset + index] === segment,
  );
}

function ruleMatches(rule, pathSegments) {
  const { segments, anchoredAtEnd } = rule;
  if (segments.length === 0 || pathSegments.length < segments.length)
    return false;
  if (anchoredAtEnd) {
    return segmentsMatchAt(
      pathSegments,
      segments,
      pathSegments.length - segments.length,
    );
  }
  const lastOffset = pathSegments.length - segments.length;
  for (let offset = 0; offset <= lastOffset; offset += 1) {
    if (segmentsMatchAt(pathSegments, segments, offset)) return true;
  }
  return false;
}

function protectedFragmentOf(path, rules) {
  const pathSegments = pathSegmentsOf(path);
  return rules.find((rule) => ruleMatches(rule, pathSegments))?.fragment;
}

// ── Shell command arguments ─────────────────────────────────────────────────────────
const SEGMENT_SEPARATOR = /;|&&|\|\||\||\n/;
const ARGUMENT_PATTERN = /"([^"]*)"|'([^']*)'|(\S+)/g;
const KEY_VALUE_PREFIX = /^-{0,2}[\w-]+=/;

function stripLeadingWrappers(segment) {
  const tokens = segment.trim().split(/\s+/);
  while (tokens.length > 0 && /^(?:sudo|command|env|\w+=\S*)$/i.test(tokens[0]))
    tokens.shift();
  return tokens.join(' ');
}

function argumentsOf(text) {
  const found = [];
  for (const match of text.matchAll(ARGUMENT_PATTERN)) {
    const token =
      match[1] ?? match[2] ?? match[3].replace(KEY_VALUE_PREFIX, '');
    if (token && !/[$`%]/.test(token)) found.push(token);
  }
  return found;
}

function mutatingCommandPatterns(sources) {
  return compileRegexList(
    sources.map((source) => String.raw`^(?:${source})(?=\s|$)`),
  ).patterns;
}

function mutatedArguments(command, patterns) {
  const found = [];
  for (const rawSegment of String(command).split(SEGMENT_SEPARATOR)) {
    const segment = stripLeadingWrappers(rawSegment);
    const matched = patterns
      .map((pattern) => pattern.exec(segment))
      .find(Boolean);
    if (matched) found.push(...argumentsOf(segment.slice(matched[0].length)));
  }
  return found;
}

function denyProtected(target, fragment) {
  deny(
    CONFIG_KEY,
    `Writing to '${target}' is not allowed: it matches the protected path '${fragment}'. ` +
      'Reading it is fine; to change it, ask the user, or edit protectedPaths under ' +
      `${CONFIG_KEY} in .ai/config.json.`,
  );
}

function checkTargets(targets, rules) {
  for (const target of targets) {
    const fragment = protectedFragmentOf(target, rules);
    if (fragment) denyProtected(target, fragment);
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      protectedPaths: DEFAULT_PROTECTED_PATHS,
      mutatingCommands: DEFAULT_MUTATING_COMMANDS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const rules = parameters.protectedPaths
      .map(fragmentRule)
      .filter((rule) => rule.segments.length > 0);
    if (rules.length === 0) return;

    if (toolInGroups(toolName, ['write'])) {
      checkTargets([writtenPathOf(toolInput)].filter(Boolean), rules);
      return;
    }
    if (!toolInGroups(toolName, ['shell'])) return;

    const command = shellCommandOf(toolInput);
    if (!command.trim()) return;
    checkTargets(shellWrittenPaths(command), rules);
    const patterns = mutatingCommandPatterns(parameters.mutatingCommands);
    if (patterns.length > 0)
      checkTargets(mutatedArguments(command, patterns), rules);
  },
);
