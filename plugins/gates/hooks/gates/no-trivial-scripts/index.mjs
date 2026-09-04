// no-trivial-scripts — denies inline interpreter scripts (node -e, python -c, sed -i,
// perl -e, PowerShell one-liners with [IO.File]/Set-Content/Add-Content) when they perform
// file operations that the Edit or Write tool would handle directly: inserting a line,
// replacing text, creating a file, appending content. Legitimate uses of inline scripts
// (JSON processing, running a test harness, computing a value) are not caught because they
// don't touch the filesystem.
//
// Deterministic: pattern match on the command, unconditional deny. No model judgment.

import {
  deny,
  runGate,
  shellCommandOf,
  toolInGroups,
} from '../../lib/hook-io.mjs';

const GATE_ID = 'no-trivial-scripts';
const CONFIG_KEY = 'blockTrivialInlineScripts';

// Node/Deno/Bun inline eval doing file operations
const NODE_EVAL_PATTERN =
  /\b(?:node|deno|bun)\b(?:\s+-\S+)*?\s+(?:-e|--eval|-p|--print)\b/i;
const NODE_FILE_OPS =
  /\b(?:writeFileSync|appendFileSync|mkdirSync|unlinkSync|renameSync|copyFileSync|fs\.writeFile|fs\.appendFile|fs\.unlink|fs\.rename|fs\.mkdir|fs\.copyFile|createWriteStream)\b/;

// Python inline doing file operations
const PYTHON_EVAL_PATTERN =
  /\b(?:python3?)\b(?:\s+-\S+)*?\s+(?:-c)\b/i;
const PYTHON_FILE_OPS =
  /\b(?:open\s*\([^)]*,\s*['"][wax]|\.write\s*\(|shutil\.|os\.rename|os\.remove|os\.unlink|os\.makedirs|pathlib\.Path\b[^)]*\.write_text)\b/;

// sed/awk/perl inline edits — these are always file edits
const SED_INLINE_PATTERN = /\bsed\s+(?:-[^;\s]*\s+)*-i/;
const PERL_INLINE_PATTERN = /\bperl\s+(?:-[^;\s]*\s+)*-[ip]/;
const AWK_INLINE_PATTERN = /\bawk\s+(?:-[^;\s]*\s+)*-i\s+inplace\b/;

// PowerShell file manipulation one-liners
const PS_FILE_OPS_PATTERN =
  /\b(?:Set-Content|Add-Content|Out-File|\[System\.IO\.File\]::(?:WriteAll|AppendAll)|New-Item\s[^|;]*-ItemType\s+File)\b/i;

const REMEDY =
  'This command uses an inline script for a file operation that the Edit or Write tool ' +
  'handles directly. Use Edit to modify existing files (insert, replace, delete lines) ' +
  'or Write to create new files. Inline scripts are for computation, not file manipulation.';

function checkCommand(command) {
  if (!command) return;

  // Node/Deno/Bun -e with file operations
  const nodeMatch = NODE_EVAL_PATTERN.exec(command);
  if (nodeMatch) {
    const afterEval = command.slice(nodeMatch.index + nodeMatch[0].length);
    if (NODE_FILE_OPS.test(afterEval)) {
      deny(CONFIG_KEY, `${REMEDY} (detected: inline Node.js file operation)`);
    }
  }

  // Python -c with file operations
  const pythonMatch = PYTHON_EVAL_PATTERN.exec(command);
  if (pythonMatch) {
    const afterEval = command.slice(pythonMatch.index + pythonMatch[0].length);
    if (PYTHON_FILE_OPS.test(afterEval)) {
      deny(CONFIG_KEY, `${REMEDY} (detected: inline Python file operation)`);
    }
  }

  // sed -i is always an in-place file edit
  if (SED_INLINE_PATTERN.test(command)) {
    deny(
      CONFIG_KEY,
      `${REMEDY} (detected: sed -i in-place edit — use Edit tool instead)`,
    );
  }

  // perl -i/-p is always an in-place file edit
  if (PERL_INLINE_PATTERN.test(command)) {
    deny(
      CONFIG_KEY,
      `${REMEDY} (detected: perl -i/-p in-place edit — use Edit tool instead)`,
    );
  }

  // awk -i inplace
  if (AWK_INLINE_PATTERN.test(command)) {
    deny(
      CONFIG_KEY,
      `${REMEDY} (detected: awk -i inplace — use Edit tool instead)`,
    );
  }

  // PowerShell file write one-liners
  if (PS_FILE_OPS_PATTERN.test(command)) {
    deny(
      CONFIG_KEY,
      `${REMEDY} (detected: PowerShell file write cmdlet — use Edit or Write tool instead)`,
    );
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {},
  },
  ({ toolName, toolInput }) => {
    if (!toolInGroups(toolName, ['shell'])) return;
    checkCommand(shellCommandOf(toolInput));
  },
);
