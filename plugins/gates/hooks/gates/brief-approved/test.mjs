import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  delegate,
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
} from '../../lib/testing.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const CATALOG = join('.ai', 'feature_list.json');
const CHECKOUT = join('.ai', 'features', 'checkout');
const BRIEF = join(CHECKOUT, 'brief.md');
const IMPLEMENT_CHECKOUT =
  'Nivel: STANDARD\nImplementá .ai/features/checkout/ el flujo de pago.';

const APPROVED_BRIEF = [
  '---',
  'status: approved',
  'approved_at: 2026-09-01T10:00:00Z',
  'approval_quote: "sí, leí el brief completo y está bien"',
  '---',
  '# Checkout',
].join('\n');
const UNAPPROVED_BRIEF = '# Checkout\n\nObjetivo: cobrar.';

function run(files, payload = delegate(IMPLEMENT_CHECKOUT, 'backend'), config) {
  const project = makeProject({
    config,
    files: { [CATALOG]: JSON.stringify({ features: [] }), ...files },
  });
  return runGateProcess(GATE, payload, { project });
}

test('on by default: an unapproved brief denies without any config', () => {
  const result = run({ [BRIEF]: UNAPPROVED_BRIEF });
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /checkout -> /);
  assert.match(messageOf(result), /approval_quote/);
});

test('an approved brief (status + non-empty quote) allows', () => {
  assert.equal(run({ [BRIEF]: APPROVED_BRIEF }), null);
});

test('a UTF-8 BOM before the frontmatter does not break approval detection', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.equal(run({ [BRIEF]: bom + APPROVED_BRIEF }), null);
});

test('CRLF line endings in the frontmatter are accepted', () => {
  assert.equal(run({ [BRIEF]: APPROVED_BRIEF.replaceAll('\n', '\r\n') }), null);
});

test('status: "approved" with quotes is accepted', () => {
  const brief = APPROVED_BRIEF.replace(
    'status: approved',
    'status: "approved"',
  );
  assert.equal(run({ [BRIEF]: brief }), null);
});

test('an empty approval_quote is not an approval', () => {
  const brief = APPROVED_BRIEF.replace(
    /approval_quote: .*/,
    'approval_quote: ""',
  );
  assert.ok(isDeny(run({ [BRIEF]: brief })));
});

test('status: approved without any approval_quote is not an approval', () => {
  const brief = APPROVED_BRIEF.replace(/approval_quote: .*\n/, '');
  assert.ok(isDeny(run({ [BRIEF]: brief })));
});

test("a feature without brief.md is not this gate's business (sdd-specs covers it)", () => {
  assert.equal(
    run({ [join(CHECKOUT, 'requirements.md')]: '# Requirements' }),
    null,
  );
  assert.equal(run({ [join(CHECKOUT, '.keep')]: '' }), null);
});

test('no feature tree at all: the gate stays silent', () => {
  const project = makeProject();
  assert.equal(
    runGateProcess(GATE, delegate(IMPLEMENT_CHECKOUT, 'backend'), {
      project,
    }),
    null,
  );
});

test('an exempt subagent is matched case-insensitively', () => {
  assert.equal(
    run({ [BRIEF]: UNAPPROVED_BRIEF }, delegate(IMPLEMENT_CHECKOUT, 'Explore')),
    null,
  );
});

test('exemptSubagents override exempts a custom type', () => {
  assert.equal(
    run({ [BRIEF]: UNAPPROVED_BRIEF }, delegate(IMPLEMENT_CHECKOUT, 'worker'), {
      gates: {
        requireApprovedBriefBeforeImplementing: {
          enabled: true,
          exemptSubagents: ['worker'],
        },
      },
    }),
    null,
  );
});

test('a decoy LEVEL: MICRO before the operative HIGH-RISK still denies', () => {
  const prompt =
    'Nivel: MICRO (tarea anterior). Nivel: HIGH-RISK\nImplementá .ai/features/checkout/ el flujo de pago.';
  assert.ok(
    isDeny(run({ [BRIEF]: UNAPPROVED_BRIEF }, delegate(prompt, 'backend'))),
  );
});

test('a QUESTION-level prompt is exempt', () => {
  const prompt = 'Nivel: QUESTION\nExplicá .ai/features/checkout/ hoy.';
  assert.equal(
    run({ [BRIEF]: UNAPPROVED_BRIEF }, delegate(prompt, 'backend')),
    null,
  );
});

test('a prompt with no declared level is exempt', () => {
  assert.equal(
    run(
      { [BRIEF]: UNAPPROVED_BRIEF },
      delegate(
        'Implementá .ai/features/checkout/ el flujo de pago.',
        'backend',
      ),
    ),
    null,
  );
});

test('disabled by config: the gate does not run', () => {
  assert.equal(
    run({ [BRIEF]: UNAPPROVED_BRIEF }, undefined, {
      gates: { requireApprovedBriefBeforeImplementing: false },
    }),
    null,
  );
});

test('two cited features: only the unapproved one is listed', () => {
  const refunds = join('.ai', 'features', 'refunds', 'brief.md');
  const prompt =
    'Nivel: STANDARD\nImplementá .ai/features/checkout/ y .ai/features/refunds/ juntos.';
  const result = run(
    { [BRIEF]: APPROVED_BRIEF, [refunds]: UNAPPROVED_BRIEF },
    delegate(prompt, 'backend'),
  );
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /refunds -> /);
  assert.doesNotMatch(messageOf(result), /checkout -> /);
});
