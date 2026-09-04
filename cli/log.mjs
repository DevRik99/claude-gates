import { existsSync, readFileSync } from 'node:fs';
import { logPathFor } from '../plugins/gates/hooks/lib/gate-log.mjs';
import { findProjectRoot } from './config.mjs';

const DEFAULT_TAIL = 30;
const TIMESTAMP_LENGTH = 'YYYY-MM-DD HH:MM:SS'.length;
const DECISION_COLUMN_WIDTH = 6;

export function readLogEntries(cwd) {
  const path = logPathFor(findProjectRoot(cwd));
  if (!existsSync(path)) return { path, entries: [] };
  const entries = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { path, entries };
}

export function filterEntries(entries, { gate, decision, since } = {}) {
  const sinceTime = since ? Date.parse(since) : Number.NaN;
  return entries.filter((entry) => {
    if (gate && entry.gate !== gate && entry.configKey !== gate) return false;
    if (decision && entry.decision !== decision) return false;
    if (!Number.isNaN(sinceTime) && Date.parse(entry.ts) < sinceTime)
      return false;
    return true;
  });
}

export function renderEntry(entry) {
  const stamp = String(entry.ts ?? '')
    .replace('T', ' ')
    .slice(0, TIMESTAMP_LENGTH);
  const decision = String(entry.decision ?? '').padEnd(DECISION_COLUMN_WIDTH);
  const tool = entry.tool ? ` ${entry.tool}` : '';
  return `${stamp}  ${decision} ${entry.gate}${tool}\n    ${entry.summary ?? ''}\n    → ${entry.reason ?? ''}`;
}

export function runLog(
  options,
  { cwd = process.cwd(), out = process.stdout } = {},
) {
  const { path, entries } = readLogEntries(cwd);
  const filtered = filterEntries(entries, {
    gate: options.gate,
    decision: options.deny ? 'deny' : options.decision,
    since: options.since,
  });
  const tail = Number(options.tail) > 0 ? Number(options.tail) : DEFAULT_TAIL;
  const shown = options.all ? filtered : filtered.slice(-tail);
  if (options.json) {
    out.write(`${JSON.stringify(shown, null, 2)}\n`);
    return;
  }
  if (shown.length === 0) {
    out.write(`No gate decisions recorded (${path}).\n`);
    return;
  }
  out.write(`${shown.map(renderEntry).join('\n')}\n`);
  out.write(
    `\n${shown.length} of ${filtered.length} decision(s) shown from ${path}\n`,
  );
}
