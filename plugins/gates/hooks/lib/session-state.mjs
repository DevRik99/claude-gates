// session-state — per-session scratch state for gates that must remember something across
// the separate process Claude Code spawns for every hook call (a retry counter, a timestamp,
// a set of libraries already looked up). One implementation, so every stateful gate gets the
// same guarantees:
//
//   - The session id is SANITIZED before it becomes a path segment: a payload carrying
//     `../../x` or a number can neither escape the state root nor crash `path.join`.
//   - A missing session id falls back to a bucket keyed by the PROJECT, not one global
//     bucket shared by every session on the machine.
//   - Writes are ATOMIC (temp file + rename), so a concurrent hook process never reads a
//     half-written file.
//   - Stale session directories are PRUNED opportunistically (older than `ttlMs`, default 7
//     days), so %TEMP% does not accumulate one directory per session forever.
//   - A read or write failure degrades to "no state" / "not persisted", never to a throw:
//     a gate that cannot count must not block, and a warn-only gate must never deny
//     because its temp directory was read-only.
//
// State lives under os.tmpdir()/claude-gates/<gateId>/<session>/state.json — never a path
// that bakes in a username or a machine name.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const STATE_ROOT = join(tmpdir(), 'claude-gates');
const STATE_FILE = 'state.json';
const NO_SESSION_PREFIX = 'no-session-';
const MAX_SEGMENT_LENGTH = 80;
const HASH_LENGTH = 12;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const DEFAULT_TTL_DAYS = 7;
const DEFAULT_TTL_MS = DEFAULT_TTL_DAYS * MS_PER_DAY;
// Pruning scans the gate's directory; doing it on every call would be wasteful, so it runs
// on roughly one call in this many (cheap, and still bounds growth).
const PRUNE_EVERY = 25;

function shortHash(text) {
  return createHash('sha256')
    .update(String(text))
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/** A filesystem-safe, bounded segment for a session id; project-keyed when absent. */
export function sessionSegmentFor(sessionId, cwd = process.cwd()) {
  const raw = String(sessionId ?? '').trim();
  if (!raw) return `${NO_SESSION_PREFIX}${shortHash(cwd)}`;
  const safe = raw.replace(/[^\w-]/g, '_');
  return safe.length > MAX_SEGMENT_LENGTH
    ? `${safe.slice(0, MAX_SEGMENT_LENGTH - HASH_LENGTH - 1)}-${shortHash(raw)}`
    : safe;
}

/** Where a gate's state for this session lives. */
export function stateFileFor(gateId, sessionId, { cwd = process.cwd() } = {}) {
  return join(
    STATE_ROOT,
    gateId,
    sessionSegmentFor(sessionId, cwd),
    STATE_FILE,
  );
}

/** The persisted state object, or `fallback` when absent/corrupt/unreadable. */
export function readSessionState(gateId, sessionId, fallback = {}, options) {
  const path = stateFileFor(gateId, sessionId, options);
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function pruneStale(gateDirectory, ttlMs) {
  try {
    const cutoff = Date.now() - ttlMs;
    for (const entry of readdirSync(gateDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(gateDirectory, entry.name);
      const file = join(directory, STATE_FILE);
      const stamp = existsSync(file)
        ? statSync(file).mtimeMs
        : statSync(directory).mtimeMs;
      if (stamp < cutoff) rmSync(directory, { recursive: true, force: true });
    }
  } catch {
    // Pruning is housekeeping; failing at it never affects the gate.
  }
}

/**
 * Persists `state` atomically. Returns true when written, false when the write failed (the
 * caller decides what "cannot persist" means for its rule — usually "cannot count").
 */
export function writeSessionState(
  gateId,
  sessionId,
  state,
  { cwd = process.cwd(), ttlMs = DEFAULT_TTL_MS } = {},
) {
  const path = stateFileFor(gateId, sessionId, { cwd });
  const directory = dirname(path);
  try {
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `${STATE_FILE}.${process.pid}.tmp`);
    writeFileSync(temporary, JSON.stringify(state), 'utf8');
    renameSync(temporary, path);
  } catch {
    return false;
  }
  // Deterministic sampling on the clock, not Math.random: roughly one write in PRUNE_EVERY.
  if (Date.now() % PRUNE_EVERY === 0) pruneStale(dirname(directory), ttlMs);
  return true;
}

/**
 * Read-modify-write in one call: `update(previous)` returns the next state, which is then
 * persisted. Returns { state, persisted }.
 */
export function updateSessionState(
  gateId,
  sessionId,
  fallback,
  update,
  options,
) {
  const previous = readSessionState(gateId, sessionId, fallback, options);
  const next = update(previous);
  const persisted = writeSessionState(gateId, sessionId, next, options);
  return { state: next, persisted };
}
