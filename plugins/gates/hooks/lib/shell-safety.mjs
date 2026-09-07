// shell-safety.mjs — "is this command harmless, and is it the way OUT of the block?"
//
// justification: no existing helper covers this. `lib/delegation.mjs` has
// `isReadOnlySubagent` (a subagent NAME whitelist — a different question), and the only
// read-only COMMAND check in the repo was a private copy inside recurrence-lock. This is
// that copy promoted to shared, so a second gate can use it instead of growing a rival.
//
// Every gate that denies a whole surface needs the same two exemptions, and missing
// either turns the gate from a guard into a trap:
//
//   1. READ-ONLY commands. `git status`, `grep`, `cat`, a test run — none can make the
//      situation the gate objects to any worse. Denying them costs the operator the
//      ability to even LOOK at why they are blocked.
//   2. The gate's OWN REMEDY. A gate whose message says "run X" must not deny X.
//      recurrence-lock got this right (it exempts edits to reincidencias.json).
//      require-task-split shipped without it and produced a hard deadlock: it denied
//      `claude-gates task add --parent`, the exact command its own message ordered, so
//      the sanctioned way out was closed and the operator had to reach in from outside
//      the harness to break the loop.
//
// The list is a WHITELIST of command heads matched word by word, so an unknown command is
// never assumed safe. `git` alone is not read-only; `git status` is.

const READ_ONLY_COMMANDS = [
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git ls-files',
  'git rev-parse',
  'cat',
  'ls',
  'dir',
  'pwd',
  'echo',
  'grep',
  'rg',
  'find',
  'head',
  'tail',
  'wc',
  'type',
  'get-content',
  'get-childitem',
  'node --test',
  'npm test',
  'npm run lint',
];

// Every segment must be read-only: `cat x && rm -rf /` must not pass on its harmless head.
const SEGMENT_SEPARATOR = /&&|\|\||[;|\n]/;

function segmentIsReadOnly(segment) {
  const words = segment.trim().toLowerCase().split(/\s+/);
  return READ_ONLY_COMMANDS.some((command) => {
    const expected = command.split(' ');
    return expected.every((word, index) => words[index] === word);
  });
}

/**
 * Whether a shell command only observes. Empty is NOT read-only (nothing to vouch for).
 * Pass `writesPaths: true` (from shellWrittenPaths) so `grep x > out.txt` cannot slip
 * through under a read-only head.
 */
export function isReadOnlyCommand(command, { writesPaths = false } = {}) {
  const text = String(command ?? '');
  if (!text.trim()) return false;
  if (writesPaths) return false;
  return text.split(SEGMENT_SEPARATOR).every(segmentIsReadOnly);
}

// Two small patterns instead of one alternation: the linter's regex-complexity budget
// rejected the combined form, and both halves must hold anyway — requiring the CLI itself
// is what stops an unrelated command that merely contains the word "task".
const REMEDY_CLI =
  /(?:npx\s+)?(?:@[\w.-]+\/)?claude-gates\b|cli[/\\]index\.mjs/i;
const REMEDY_SUBCOMMAND = /\b(?:task|enable|disable)\b/i;

/**
 * Whether the command is this toolkit's own escape hatch — registering, splitting, parking
 * or closing a task, or toggling a gate. A gate must let these through even while denying
 * everything else, or its own instructions become unreachable.
 */
export function isSelfRemedyCommand(command) {
  const text = String(command ?? '');
  return REMEDY_CLI.test(text) && REMEDY_SUBCOMMAND.test(text);
}
