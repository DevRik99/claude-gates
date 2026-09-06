import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY_ROOT } from './constants.mjs';

const CLAUDE_BIN = 'claude';

function runClaudeDefault(commandArguments) {
  return execFileSync(CLAUDE_BIN, commandArguments, {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

export function parsePluginList(listing) {
  const plugins = [];
  let current = null;
  for (const line of listing.split(/\r?\n/)) {
    const name = /^\s*(?:❯\s*)?([\w-]+)@([\w-]+)\s*$/.exec(line);
    if (name) {
      current = { plugin: name[1], marketplace: name[2] };
      plugins.push(current);
      continue;
    }
    if (!current) continue;
    const version = /^\s*Version:\s*(\S+)/.exec(line);
    if (version) current.version = version[1];
    const scope = /^\s*Scope:\s*(\S+)/.exec(line);
    if (scope) current.scope = scope[1];
  }
  return plugins;
}

export function parseMarketplaceSources(listing) {
  const sources = {};
  let current = null;
  for (const line of listing.split(/\r?\n/)) {
    const name = /^\s*(?:❯\s*)?([\w-]+)\s*$/.exec(line);
    if (name) {
      current = name[1];
      continue;
    }
    const source = /^\s*Source:\s*(\w+)\s*\(([^)]+)\)/.exec(line);
    if (source && current)
      sources[current] = { kind: source[1], path: source[2] };
  }
  return sources;
}

function withoutTrailingSlashes(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '/' || text[end - 1] === '\\')) end -= 1;
  return text.slice(0, end).toLowerCase();
}

/** Semver-ish numeric compare, shared with install.mjs so both judge staleness alike. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function diagnose({ runClaude = runClaudeDefault } = {}) {
  const manifest = JSON.parse(
    readFileSync(
      join(REPOSITORY_ROOT, '.claude-plugin', 'marketplace.json'),
      'utf8',
    ),
  );
  const packageVersion = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ).version;
  const problems = [];
  const facts = [`package: ${packageVersion} at ${REPOSITORY_ROOT}`];
  let plugins;
  let sources;
  try {
    plugins = parsePluginList(runClaude(['plugin', 'list']));
    sources = parseMarketplaceSources(
      runClaude(['plugin', 'marketplace', 'list']),
    );
  } catch (error) {
    problems.push(
      `could not query Claude Code (${error?.message ?? error}); is \`claude\` on PATH?`,
    );
    return { packageVersion, facts, problems };
  }
  const ours = plugins.filter((plugin) =>
    manifest.plugins.some((declared) => declared.name === plugin.plugin),
  );
  if (ours.length === 0) {
    problems.push(
      'no claude-gates plugin is installed in Claude Code: run `claude-gates init --global --defaults --yes`',
    );
  }
  for (const plugin of ours) {
    facts.push(
      `${plugin.plugin}@${plugin.marketplace} ${plugin.version} (${plugin.scope})`,
    );
    if (compareVersions(plugin.version, packageVersion) < 0) {
      problems.push(
        `${plugin.plugin} (${plugin.scope}) runs ${plugin.version} but this package is ${packageVersion}: ` +
          'run `claude-gates init --global --defaults --yes` from this package to re-point the marketplace and reinstall',
      );
    }
    const source = sources[plugin.marketplace];
    if (source?.kind === 'Directory') {
      const same =
        withoutTrailingSlashes(source.path) ===
        withoutTrailingSlashes(REPOSITORY_ROOT);
      if (!same)
        problems.push(
          `marketplace "${plugin.marketplace}" serves from ${source.path}, not from this package (${REPOSITORY_ROOT})`,
        );
    }
  }
  return { packageVersion, facts, problems };
}

export function renderDiagnosis(report) {
  const lines = report.facts.map((fact) => `  ${fact}`);
  if (report.problems.length === 0) lines.push('\nAll good.');
  else
    lines.push(
      '\nProblems:',
      ...report.problems.map((problem) => `  - ${problem}`),
    );
  return `${lines.join('\n')}\n`;
}
