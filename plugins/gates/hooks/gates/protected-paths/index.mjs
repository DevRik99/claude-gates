// protected-paths — denies writes and mutating shell commands that target a path
// containing one of the project's protected fragments (.env, lockfiles, the harness
// itself). Migrated from ~/.claude/hooks/guard-protected-paths.mjs: that guard protected
// hardcoded "code directories" (src, tests) to force delegation through a Leader role.
// This gate keeps only the path-protection mechanism — sensitive files no write should
// ever touch — and drops the Leader-role/delegation policy, which is a different concern.
//
// ── What a project can configure (params) ───────────────────────────────────────────
//   protectedPaths     path fragments (case-insensitive) that no write or mutating
//                       command may target. Replaces the built-in list wholesale.
//   mutatingCommands    shell command names treated as mutating, so a merely-reading
//                       command that mentions a protected path (echo, cat, grep) is
//                       never denied. Replaces the built-in list wholesale.
// The defaults live here, in the source, so a project reads them and knows exactly what
// its override replaces.

import { runGate, deny, TOOL_GROUPS } from '../../lib/hook-io.mjs';

const GATE_ID = 'protected-paths';
const CONFIG_KEY = 'blockWritesToProtectedPaths';

const WRITE_TOOLS = new Set(TOOL_GROUPS.write);
const SHELL_TOOLS = new Set(TOOL_GROUPS.shell);

const DEFAULT_PROTECTED_PATHS = [
  '.env',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'hooks/',
];

const DEFAULT_MUTATING_COMMANDS = [
  'touch',
  'rm',
  'cp',
  'mv',
  'sed\\s+-i',
  'tee',
  'install',
  'chmod',
  'chown',
  'truncate',
];

function escapeRegExp(fragment) {
  return fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The path a write tool targets, across the field names different tools use. */
function writeTargetFrom(toolInput) {
  return String(
    toolInput.TargetFile ??
      toolInput.target_file ??
      toolInput.file_path ??
      toolInput.path ??
      '',
  );
}

function isProtectedPath(path, protectedPaths) {
  const normalized = path.toLowerCase();
  return protectedPaths.some((fragment) =>
    normalized.includes(fragment.toLowerCase()),
  );
}

function buildCommandPatterns(protectedPaths, mutatingCommands) {
  const pathAlternation = protectedPaths.map(escapeRegExp).join('|');
  const mutatingAlternation = mutatingCommands.join('|');
  const wordBoundary = String.raw`\b`;
  const redirectPrefix = String.raw`>>?\s*\S*`;
  return {
    mutatingCommand: new RegExp(
      `${wordBoundary}(${mutatingAlternation})${wordBoundary}`,
      'i',
    ),
    protectedTarget: new RegExp(`(${pathAlternation})`, 'i'),
    redirectToProtected: new RegExp(
      `${redirectPrefix}(${pathAlternation})`,
      'i',
    ),
  };
}

/** The write-tool branch: deny when the target path matches a protected fragment. */
function checkWrite(toolInput, protectedPaths) {
  const target = writeTargetFrom(toolInput);
  if (target && isProtectedPath(target, protectedPaths)) {
    deny(
      GATE_ID,
      `Writing to '${target}' is not allowed: it matches a protected path (${protectedPaths.join(', ')}).`,
    );
  }
}

/** The shell-tool branch: deny a mutating command whose target matches a protected path. */
function checkShellCommand(toolInput, protectedPaths, mutatingCommands) {
  const command = String(toolInput.CommandLine ?? toolInput.command ?? '');
  if (!command.trim()) return;

  const { mutatingCommand, protectedTarget, redirectToProtected } =
    buildCommandPatterns(protectedPaths, mutatingCommands);

  const targetsProtected =
    redirectToProtected.test(command) ||
    (mutatingCommand.test(command) && protectedTarget.test(command));

  if (targetsProtected) {
    deny(
      GATE_ID,
      `This command targets a protected path (${protectedPaths.join(', ')}) with a mutating operation. ` +
        'Reading (echo/cat/grep) is fine; modifying it is not.',
    );
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      protectedPaths: DEFAULT_PROTECTED_PATHS,
      mutatingCommands: DEFAULT_MUTATING_COMMANDS,
    },
  },
  ({ toolName, toolInput, parameters }) => {
    const isWrite = WRITE_TOOLS.has(toolName);
    const isShell = SHELL_TOOLS.has(toolName);
    if (!isWrite && !isShell) return;

    const protectedPaths = parameters.protectedPaths ?? [];
    if (protectedPaths.length === 0) return;

    if (isWrite) {
      checkWrite(toolInput, protectedPaths);
      return;
    }

    checkShellCommand(
      toolInput,
      protectedPaths,
      parameters.mutatingCommands ?? [],
    );
  },
);
