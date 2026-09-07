// comment-ok: file header describing the fixture setup (a fake HOME), not the code.
// The claim rule under test directly: when a task another agent claimed stops blocking you.
// The real trigger is whether the owning session is still alive, not a fixed clock, so each
// case plants a fake transcript and back-dates it.
//
// os.homedir() reads USERPROFILE (Windows) or HOME (POSIX) on every call, so pointing both at
// a temp directory keeps the real home out of these tests.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  blocksCaller,
  claimIsLive,
  DEFAULT_IDLE_MS,
  idleWindowMs,
  ownerSessionState,
} from '../task-claims.mjs';

const OWNER = 'agent-one';
const CALLER = 'agent-two';
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60 * 1000;

function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), 'claims-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function projectRoot(claimIdleMinutes) {
  const root = mkdtempSync(join(tmpdir(), 'claims-root-'));
  mkdirSync(join(root, '.ai'), { recursive: true });
  const config = claimIdleMinutes === undefined ? {} : { claimIdleMinutes };
  writeFileSync(join(root, '.ai', 'config.json'), JSON.stringify(config));
  return root;
}

function plantTranscript(home, root, owner, ageMinutes) {
  const slug = String(root).replace(/[:\\/]/g, '-');
  const directory = join(home, '.claude', 'projects', slug);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${owner}.jsonl`);
  writeFileSync(file, '{}\n');
  const when = new Date(Date.now() - ageMinutes * MS_PER_MINUTE);
  utimesSync(file, when, when);
}

function claimedTask(minutesAgo = 1) {
  return {
    id: 't1',
    owner: OWNER,
    claimedAt: new Date(Date.now() - minutesAgo * MS_PER_MINUTE).toISOString(),
  };
}

test('the default idle window is one hour', () => {
  assert.equal(DEFAULT_IDLE_MS, MINUTES_PER_HOUR * MS_PER_MINUTE);
  assert.equal(idleWindowMs(projectRoot()), DEFAULT_IDLE_MS);
});

test('claimIdleMinutes in .ai/config.json overrides the default', () => {
  assert.equal(idleWindowMs(projectRoot(5)), 5 * MS_PER_MINUTE);
});

test('an invalid claimIdleMinutes falls back instead of freeing everything', () => {
  // Because a zero or a word would switch claims off silently.
  assert.equal(idleWindowMs(projectRoot(0)), DEFAULT_IDLE_MS);
  assert.equal(idleWindowMs(projectRoot('lots')), DEFAULT_IDLE_MS);
});

test('a session that wrote recently counts as active', () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 5);

  assert.equal(ownerSessionState(OWNER, root), 'active');
});

test('a session quiet for longer than the window counts as gone', () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 90);

  assert.equal(ownerSessionState(OWNER, root), 'gone');
});

test('with no transcript the state is unknown, not dead', () => {
  // Because the path may not derive the same way on another platform, and stealing a claim
  // over that is worse than waiting.
  scratchHome();
  assert.equal(ownerSessionState(OWNER, projectRoot()), 'unknown');
});

test("a gone session's claim frees immediately, even if just made", () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 90);

  assert.equal(claimIsLive(claimedTask(1), Date.now(), root), false);
  assert.equal(blocksCaller(claimedTask(1), CALLER, Date.now(), root), true);
});

test("a live session's claim holds, however old the claim is", () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 2);

  const old = claimedTask(MINUTES_PER_HOUR * 12);
  assert.equal(claimIsLive(old, Date.now(), root), true);
  assert.equal(blocksCaller(old, CALLER, Date.now(), root), false);
});

test('your own claim never blocks you', () => {
  const home = scratchHome();
  const root = projectRoot();
  plantTranscript(home, root, OWNER, 2);

  assert.equal(blocksCaller(claimedTask(1), OWNER, Date.now(), root), true);
});

test("with no transcript it falls back to the claim's own age", () => {
  scratchHome();
  const root = projectRoot(30);

  assert.equal(claimIsLive(claimedTask(5), Date.now(), root), true);
  assert.equal(claimIsLive(claimedTask(45), Date.now(), root), false);
});

test('an unclaimed task is free, and blocks whoever is acting', () => {
  assert.equal(claimIsLive({ id: 't1' }, Date.now(), projectRoot()), false);
  assert.equal(
    blocksCaller({ id: 't1' }, CALLER, Date.now(), projectRoot()),
    true,
  );
});
