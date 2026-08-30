#!/usr/bin/env node
// Directed mutation runner for the gates — the domain-specific complement to Stryker.
//
// Why this exists alongside Stryker: Stryker mutates broadly and scores overall survival,
// but the ONE property that matters for a gate is "if I break the block, a test catches it".
// This runner injects exactly the mutants that would silently disarm a gate — deny→allow,
// negated guards, regexes widened to match-nothing — and asserts each one is KILLED by the
// gate's own suite. A survivor here means the gate could stop blocking and every test would
// still be green: the exact false-green the project rules forbid.
//
// It is deliberately small and pattern-based (no AST): it edits index.mjs on disk, runs the
// gate's tests, restores the file, and records whether the suite failed (mutant killed) or
// passed (mutant survived). It never leaves a mutated file behind, even on crash.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugins',
  'gates',
  'hooks',
  'gates',
);

// A mutation is a literal string replacement applied to the gate source. Each entry names
// the class of mutant and the substitution. `all: true` mutates every occurrence; otherwise
// only the first is mutated (one mutant per application) — we generate one variant per match.
const MUTATORS = [
  {
    // Neutralize the whole deny statement without introducing any new identifier: the gate
    // simply falls through to allow(). Mutating to `allow(` instead would throw ReferenceError
    // in gates that don't import allow, and runGate would turn that throw back into a deny —
    // a false "survivor" that hides whether the TEST actually catches the missing block.
    id: 'deny-neutralized',
    reason: 'the deny statement is neutralized (no block): a test must catch the missing block',
    find: /\bdeny\((?:[^()]|\([^()]*\))*\)\s*;/g,
    replace: 'void 0;',
  },
  {
    id: 'warn-neutralized',
    reason: 'the warn statement is neutralized: a test asserting the notice must fail',
    find: /\bwarn\((?:[^()]|\([^()]*\))*\)\s*;/g,
    replace: 'void 0;',
  },
  {
    id: 'negate-early-return-guard',
    reason: 'an early-return guard is negated: the gate skips or over-acts',
    find: /\bif \(!/g,
    replace: 'if (',
  },
  {
    id: 'regex-to-match-nothing',
    reason: 'a regexp literal is widened to (?!): it matches nothing, so no detection fires',
    find: /\/(?![/*])((?:\\.|[^/\\\n])+)\/([gimsuy]*)/g,
    replace: '/(?!)/$2',
  },
];

function run(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
    return { passed: true };
  } catch (error) {
    return { passed: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function gatesWithTests() {
  return readdirSync(GATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const dir = join(GATES_DIR, name);
      return existsSync(join(dir, 'index.mjs')) && hasAnyTest(dir);
    });
}

function hasAnyTest(dir) {
  return readdirSync(dir).some((file) => file.endsWith('.test.mjs') || file === 'test.mjs');
}

// A pattern-based mutator has no AST, so it can misfire inside comments and strings — a `/`
// in a `// see .../config.json` URL looks like the start of a regexp literal. We skip any
// match whose line is a line-comment or a block-comment continuation, which removes the
// common false positives without pretending to be a real parser.
function isInCommentLine(source, at) {
  const lineStart = source.lastIndexOf('\n', at - 1) + 1;
  const trimmedBefore = source.slice(lineStart, at).trimStart();
  const firstTwo = source.slice(lineStart).trimStart().slice(0, 2);
  return firstTwo === '//' || firstTwo === '*' || trimmedBefore.includes('//');
}

// Generate concrete mutants for one source: each is {mutatorId, reason, index, mutatedText}.
// For a global mutator we emit one mutant per match site so a survivor points at a line.
function mutantsFor(source) {
  const mutants = [];
  for (const mutator of MUTATORS) {
    const matches = [...source.matchAll(mutator.find)];
    for (const [ordinal, match] of matches.entries()) {
      const at = match.index;
      if (isInCommentLine(source, at)) continue;
      const before = source.slice(0, at);
      const matched = match[0];
      const after = source.slice(at + matched.length);
      const replaced = matched.replace(new RegExp(mutator.find.source, mutator.find.flags.replace('g', '')), mutator.replace);
      if (replaced === matched) continue; // no-op replacement, skip
      mutants.push({
        mutatorId: mutator.id,
        reason: mutator.reason,
        ordinal: ordinal + 1,
        line: before.split('\n').length,
        mutatedText: before + replaced + after,
      });
    }
  }
  return mutants;
}

function baselineGreen(dir) {
  const result = run('node', ['--test'], dir);
  return result.passed;
}

function mutateGate(name) {
  const dir = join(GATES_DIR, name);
  const indexPath = join(dir, 'index.mjs');
  const original = readFileSync(indexPath, 'utf8');

  if (!baselineGreen(dir)) {
    return { name, error: 'baseline suite is RED before mutation — fix tests first' };
  }

  const mutants = mutantsFor(original);
  const survivors = [];
  let killed = 0;

  try {
    for (const mutant of mutants) {
      writeFileSync(indexPath, mutant.mutatedText);
      const result = run('node', ['--test'], dir);
      if (result.passed) {
        survivors.push({
          mutator: mutant.mutatorId,
          line: mutant.line,
          ordinal: mutant.ordinal,
          reason: mutant.reason,
        });
      } else {
        killed += 1;
      }
    }
  } finally {
    writeFileSync(indexPath, original); // always restore, even on throw
  }

  return { name, total: mutants.length, killed, survivors };
}

function main() {
  const only = process.argv.slice(2);
  const gates = only.length ? only : gatesWithTests();
  const report = [];
  let totalSurvivors = 0;

  for (const gate of gates) {
    const result = mutateGate(gate);
    report.push(result);
    if (result.error) {
      process.stdout.write(`\n✗ ${gate}: ${result.error}\n`);
      continue;
    }
    totalSurvivors += result.survivors.length;
    const mark = result.survivors.length === 0 ? '✓' : '✗';
    process.stdout.write(
      `\n${mark} ${gate}: ${result.killed}/${result.total} mutants killed` +
        (result.survivors.length ? `, ${result.survivors.length} SURVIVED\n` : '\n'),
    );
    for (const survivor of result.survivors) {
      process.stdout.write(
        `    survived: ${survivor.mutator} @ index.mjs:${survivor.line} (#${survivor.ordinal}) — ${survivor.reason}\n`,
      );
    }
  }

  process.stdout.write(
    `\n${totalSurvivors === 0 ? 'ALL MUTANTS KILLED' : `${totalSurvivors} MUTANT(S) SURVIVED`}\n`,
  );
  process.exit(totalSurvivors === 0 ? 0 : 1);
}

main();
