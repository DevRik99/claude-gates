// Red/green for the block-remote-publish gate: a real publish is denied when the gate is on,
// allowed when the project sets blockRemotePublish:false, and a mention that only describes
// a push is never a false positive.

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bash,
  delegate,
  isDeny,
  messageOf,
  runGateProcess,
} from '../../../lib/testing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_PATH = join(HERE, '..', 'index.mjs');

function runGate(payload, options) {
  return runGateProcess(GATE_PATH, payload, options);
}

const shellPush = bash('git push origin main');

test('planted violation: git push is DENIED when the gate is on (default)', () => {
  const result = runGate(shellPush);
  assert.ok(
    isDeny(result),
    'git push must be blocked by default — this is the protection',
  );
  assert.match(messageOf(result), /blockRemotePublish/);
});

test('the config flag WORKS: blockRemotePublish:false ALLOWS git push', () => {
  const result = runGate(shellPush, {
    config: { gates: { blockRemotePublish: false } },
  });
  assert.equal(
    isDeny(result),
    false,
    'with blockRemotePublish:false the push must go through — the knob the user wanted',
  );
});

test('gh pr merge is denied when on', () => {
  assert.ok(isDeny(runGate(bash('gh pr merge 42 --squash'))));
});

test('git -C /repo push (global option) is still caught', () => {
  assert.ok(
    isDeny(runGate(bash('git -C /some/repo push origin main'))),
    'a git global option must not bypass the block',
  );
});

test('delegation prompt that only DESCRIBES a push is not a false positive', () => {
  const result = runGate(
    delegate(
      'I extended the guard so it denies "git push" without authorization.',
    ),
  );
  assert.equal(
    isDeny(result),
    false,
    'a reporting-verb-governed mention must not deny',
  );
});

test('delegation prompt that ORDERS a push is denied', () => {
  assert.ok(
    isDeny(runGate(delegate('Now run git push origin main to publish.'))),
  );
});

test('env-var-prefixed git push is still caught (FOO=bar git push ...)', () => {
  assert.ok(isDeny(runGate(bash('FOO=bar git push origin main'))));
});

test('"command gh pr merge" wrapper does not evade the pattern', () => {
  assert.ok(isDeny(runGate(bash('command gh pr merge 12'))));
});

test('KNOWN: reporting verb inside lookback window before an order is allowed (pre-existing limitation)', () => {
  const result = runGate(
    delegate(
      'The changelog mentions we should run git push origin main now to finish the release.',
    ),
  );
  assert.equal(isDeny(result), false);
});

// ── Regressions from the audit ──────────────────────────────────────────────────────

test('publishRules given as bare strings (the registry form) work instead of denying everything', () => {
  const config = {
    gates: {
      blockRemotePublish: {
        enabled: true,
        publishRules: [String.raw`\bgit\s+push\b`],
      },
    },
  };
  assert.equal(
    runGate(bash('git status'), { config }),
    null,
    'a bare-string rule must not crash the gate into deny-all',
  );
  assert.ok(isDeny(runGate(shellPush, { config })));
  assert.equal(
    runGate(bash('gh pr merge 1'), { config }),
    null,
    'the override replaces the built-in gh rule',
  );
});

test('a malformed publishRules entry is skipped, not a deny-all', () => {
  const config = {
    gates: { blockRemotePublish: { enabled: true, publishRules: ['('] } },
  };
  assert.equal(runGate(bash('git status'), { config }), null);
  assert.equal(runGate(shellPush, { config }), null);
});

test('git.exe and a quoted -C path with a space still count as a push', () => {
  assert.ok(isDeny(runGate(bash('git.exe push'))));
  assert.ok(isDeny(runGate(bash('git -C "C:/My Repo" push'))));
});

test('gh with -R / --repo between the words is still a publish', () => {
  assert.ok(isDeny(runGate(bash('gh -R owner/repo pr merge 1'))));
  assert.ok(isDeny(runGate(bash('gh pr --repo o/r merge 1'))));
  assert.ok(isDeny(runGate(bash('gh release --repo o/r create v1'))));
});

test('a mention of git push inside grep, git log --grep or echo is not a publish', () => {
  assert.equal(runGate(bash('grep -rn "git push" docs/')), null);
  assert.equal(runGate(bash('git log --grep="git push"')), null);
  assert.equal(runGate(bash('echo "remember to git push later"')), null);
  assert.equal(runGate(bash('# git push is done by CI\nnpm test')), null);
});

test('git push --dry-run writes nothing and is allowed', () => {
  assert.equal(runGate(bash('git push --dry-run origin main')), null);
});

test('a push chained after another command, or inside sh -c, is still caught', () => {
  assert.ok(isDeny(runGate(bash('npm test && git push origin main'))));
  assert.ok(isDeny(runGate(bash('sh -c "git push origin main"'))));
  assert.ok(isDeny(runGate(bash('echo $(git push origin main)'))));
});

test('delegation prompts that forbid or hand off the push are allowed', () => {
  for (const prompt of [
    'Do NOT run git push under any circumstance.',
    'Never push: git push is forbidden here.',
    'Prepare the release; the user will run git push themselves.',
  ]) {
    assert.equal(runGate(delegate(prompt)), null, `${prompt} must be allowed`);
  }
});
