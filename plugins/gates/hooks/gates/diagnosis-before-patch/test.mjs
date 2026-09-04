import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  edit,
  isDeny,
  isWarn,
  messageOf,
  runGateProcess,
  write,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

const CONFIG_FILE = 'src/config.js';

function runGate(payload, { config, files } = {}) {
  return runGateProcess(GATE, payload, { config, files });
}

// Assertions updated with the audited behavior: only a CHANGE of a value warns, so each
// case seeds the previous value on disk.
test('warns when a timeout value is being changed', () => {
  assert.ok(
    isWarn(
      runGate(write(CONFIG_FILE, 'const REQUEST_TIMEOUT_MS = 60000;'), {
        files: { [CONFIG_FILE]: 'const REQUEST_TIMEOUT_MS = 30000;' },
      }),
    ),
  );
  assert.ok(
    isWarn(
      runGate(write(CONFIG_FILE, 'max_retry: 5'), {
        files: { [CONFIG_FILE]: 'max_retry: 3' },
      }),
    ),
  );
});

test('allows content that does not touch a timeout/retry key', () => {
  assert.equal(
    runGate(write(CONFIG_FILE, 'const x = 1;'), {
      files: { [CONFIG_FILE]: 'const x = 2;' },
    }),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    runGate(write(CONFIG_FILE, 'TIMEOUT_MS = 5000'), {
      config: { gates: { warnTimeoutChangeWithoutDiagnosis: false } },
      files: { [CONFIG_FILE]: 'TIMEOUT_MS = 1000' },
    }),
    null,
  );
});

test('project timeoutPatterns override replaces the built-in list', () => {
  const config = {
    gates: {
      warnTimeoutChangeWithoutDiagnosis: {
        enabled: true,
        timeoutPatterns: ['custom_limit'],
      },
    },
  };
  assert.equal(
    runGate(write(CONFIG_FILE, 'TIMEOUT_MS = 5000'), {
      config,
      files: { [CONFIG_FILE]: 'TIMEOUT_MS = 1000' },
    }),
    null,
  );
  assert.ok(
    isWarn(
      runGate(write(CONFIG_FILE, 'custom_limit = 5'), {
        config,
        files: { [CONFIG_FILE]: 'custom_limit = 3' },
      }),
    ),
  );
});

// ── Only a CHANGE warns ─────────────────────────────────────────────────────────────
test('a new file containing a timeout value never warns', () => {
  assert.equal(
    runGate(write(CONFIG_FILE, 'const REQUEST_TIMEOUT_MS = 30000;')),
    null,
  );
});

test('a rewrite that keeps the timeout value unchanged never warns', () => {
  const content = 'const REQUEST_TIMEOUT_MS = 30000;\nexport {};';
  assert.equal(
    runGate(write(CONFIG_FILE, `${content}\n// touched`), {
      files: { [CONFIG_FILE]: content },
    }),
    null,
  );
});

test('an Edit warns only when old_string and new_string carry different values for the same key', () => {
  assert.ok(
    isWarn(
      runGate(edit(CONFIG_FILE, 'TIMEOUT_MS = 60000', 'TIMEOUT_MS = 30000')),
    ),
  );
  assert.equal(
    runGate(
      edit(CONFIG_FILE, 'TIMEOUT_MS = 30000; // why', 'TIMEOUT_MS = 30000'),
    ),
    null,
  );
  assert.equal(
    runGate(edit(CONFIG_FILE, 'const IDLE_MS = 10;', 'const y = 2;')),
    null,
    'a key introduced by the edit is not a changed value',
  );
});

test('the warning names the key and both values', () => {
  const result = runGate(
    edit(CONFIG_FILE, 'TIMEOUT_MS = 60000', 'TIMEOUT_MS = 30000'),
  );
  assert.match(messageOf(result), /TIMEOUT_MS: 30000 -> 60000/);
});

// ── Malformed config never escalates an advisory gate to a deny ─────────────────────
test('a malformed timeoutPatterns entry is skipped and the gate never denies', () => {
  const config = {
    gates: {
      warnTimeoutChangeWithoutDiagnosis: {
        enabled: true,
        timeoutPatterns: ['(unclosed', 'custom_limit'],
      },
    },
  };
  const result = runGate(
    edit(CONFIG_FILE, 'custom_limit = 5', 'custom_limit = 3'),
    { config },
  );
  assert.ok(isWarn(result));
  assert.ok(!isDeny(result));
});
