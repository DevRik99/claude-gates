import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRegistry, validateRegistry, allGates } from '../registry.mjs';
import {
  MODES,
  resolveSelection,
  adoptionOf,
  summarize,
} from '../selection.mjs';

const registry = loadRegistry();
const keys = allGates(registry).map((gate) => gate.configKey);

test('the shipped registry is valid', () => {
  assert.deepEqual(validateRegistry(registry), []);
});

test('validateRegistry catches duplicate configKey and unknown event', () => {
  const broken = {
    gateVersion: '1.0.0',
    families: [
      {
        id: 'x',
        name: 'X',
        gates: [
          {
            id: 'a',
            configKey: 'k',
            default: true,
            event: 'PreToolUse',
            tools: [],
            description: 'a',
          },
          {
            id: 'b',
            configKey: 'k',
            default: true,
            event: 'Nope',
            tools: [],
            description: 'b',
          },
        ],
      },
    ],
  };
  const problems = validateRegistry(broken);
  assert.ok(problems.some((problem) => /duplicate configKey: k/.test(problem)));
  assert.ok(problems.some((problem) => /gates\.1\.event/.test(problem)));
});

// A one-gate registry whose gate fields are overridable, so each test tweaks only the
// field it checks. Every level carries its required description/name.
function oneGateRegistry(gateOverrides) {
  return {
    gateVersion: '1.0.0',
    families: [
      {
        id: 'x',
        name: 'X',
        description: 'family x',
        gates: [
          {
            id: 'a',
            configKey: 'k',
            default: true,
            event: 'PreToolUse',
            tools: [],
            script: 'gates/a.mjs',
            description: 'gate a',
            ...gateOverrides,
          },
        ],
      },
    ],
  };
}

const ABSOLUTE_SCRIPT = `${'/'}etc/evil.mjs`;

test('validateRegistry requires a valid relative .mjs script per gate', () => {
  const withoutScript = oneGateRegistry({});
  delete withoutScript.families[0].gates[0].script;
  assert.ok(validateRegistry(withoutScript).some((p) => /script/.test(p)));

  assert.ok(
    validateRegistry(oneGateRegistry({ script: ABSOLUTE_SCRIPT })).some((p) =>
      /script/.test(p),
    ),
  );
  assert.ok(
    validateRegistry(oneGateRegistry({ script: '../escape.mjs' })).some((p) =>
      /script/.test(p),
    ),
  );
  assert.deepEqual(
    validateRegistry(oneGateRegistry({ script: 'gates/ok.mjs' })),
    [],
  );
});

test('validateRegistry rejects a param that is not camelCase or has a bad type', () => {
  assert.ok(
    validateRegistry(
      oneGateRegistry({
        params: [{ name: 'Bad-Name', type: 'string', description: 'd' }],
      }),
    ).length > 0,
  );
  assert.ok(
    validateRegistry(
      oneGateRegistry({
        params: [{ name: 'ok', type: 'regex', description: 'd' }],
      }),
    ).length > 0,
  );
  assert.deepEqual(
    validateRegistry(
      oneGateRegistry({
        params: [{ name: 'ok', type: 'string[]', description: 'd' }],
      }),
    ),
    [],
  );
});

test('ALL enables every key; NONE disables every key; both cover all keys', () => {
  const all = resolveSelection(registry, MODES.ALL);
  const none = resolveSelection(registry, MODES.NONE);
  assert.deepEqual(Object.keys(all).sort(), [...keys].sort());
  assert.ok(Object.values(all).every((v) => v === true));
  assert.ok(Object.values(none).every((v) => v === false));
});

test("DEFAULTS mirrors the registry's default flags", () => {
  const map = resolveSelection(registry, MODES.DEFAULTS);
  for (const gate of allGates(registry))
    assert.equal(map[gate.configKey], gate.default, gate.id);
});

test('FAMILIES enables exactly the picked families', () => {
  const map = resolveSelection(registry, MODES.FAMILIES, {
    families: ['security'],
  });
  for (const gate of allGates(registry))
    assert.equal(map[gate.configKey], gate.family === 'security', gate.id);
});

test('GRANULAR enables exactly the picked gates', () => {
  const map = resolveSelection(registry, MODES.GRANULAR, {
    gates: ['bash-commands', 'no-reconfirm'],
  });
  const enabled = Object.entries(map)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort();
  assert.deepEqual(
    enabled,
    ['blockDestructiveShellCommands', 'requireNoReconfirmOfApproved'].sort(),
  );
});

test('unknown ids fail loudly instead of being ignored', () => {
  assert.throws(
    () => resolveSelection(registry, MODES.FAMILIES, { families: ['nope'] }),
    /Unknown family/,
  );
  assert.throws(
    () => resolveSelection(registry, MODES.GRANULAR, { gates: ['nope'] }),
    /Unknown gate/,
  );
  assert.throws(
    () => resolveSelection(registry, 'weird'),
    /Unknown selection mode/,
  );
});

test('adoptionOf: true / false / partial', () => {
  assert.equal(adoptionOf(resolveSelection(registry, MODES.ALL)), true);
  assert.equal(adoptionOf(resolveSelection(registry, MODES.NONE)), false);
  assert.equal(
    adoptionOf(
      resolveSelection(registry, MODES.FAMILIES, { families: ['security'] }),
    ),
    'partial',
  );
});

test('summarize counts per family', () => {
  const rows = summarize(
    registry,
    resolveSelection(registry, MODES.FAMILIES, { families: ['security'] }),
  );
  const security = rows.find((row) => row.family === 'security');
  assert.equal(security.enabled.length, security.total);
  assert.ok(
    rows
      .filter((row) => row.family !== 'security')
      .every((row) => row.enabled.length === 0),
  );
});
