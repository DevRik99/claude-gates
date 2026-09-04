import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 120000;
const OUTPUT_TAIL_LINES = 20;

function tail(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-OUTPUT_TAIL_LINES)
    .join('\n');
}

export function verifyCommand(
  command,
  { cwd, expect, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const exitCode = result.error ? null : result.status;
  const failure = commandFailure(result, exitCode, output, expect);
  return {
    kind: 'command',
    command,
    expect: expect ?? null,
    exitCode,
    outputTail: tail(output),
    verified: failure === null,
    verifiedAt: new Date().toISOString(),
    failure,
  };
}

function commandFailure(result, exitCode, output, expect) {
  if (result.error) return `could not run: ${result.error.message}`;
  if (exitCode !== 0) return `exit code ${exitCode}`;
  if (expect && !output.includes(expect))
    return `output does not contain "${expect}"`;
  return null;
}

export function verifyPath(path, { cwd, contains } = {}) {
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  const exists = existsSync(absolute);
  let containsFound = true;
  if (exists && contains) {
    try {
      containsFound =
        statSync(absolute).isFile() &&
        readFileSync(absolute, 'utf8').includes(contains);
    } catch {
      containsFound = false;
    }
  }
  const failure = pathFailure(path, exists, containsFound, contains);
  return {
    kind: 'path',
    path,
    contains: contains ?? null,
    exists,
    verified: failure === null,
    verifiedAt: new Date().toISOString(),
    failure,
  };
}

function pathFailure(path, exists, containsFound, contains) {
  if (!exists) return `"${path}" does not exist`;
  if (!containsFound) return `"${path}" does not contain "${contains}"`;
  return null;
}
