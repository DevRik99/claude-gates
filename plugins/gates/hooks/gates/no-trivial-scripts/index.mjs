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
const PYTHON_EVAL_PATTERN = /\bpython3?\b(?:\s+-\S+)*?\s+-c\b/i;
const PYTHON_OPEN_FOR_WRITING = /\bopen\s*\([^)]*,\s*['"][wax]/;
const PYTHON_FILE_OPS =
  /\.write\s*\(|\bshutil\.|\bos\.(?:rename|remove|unlink|makedirs)\b|\bpathlib\.Path\b[^)]*\.write_text/;

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
    if (
      PYTHON_OPEN_FOR_WRITING.test(afterEval) ||
      PYTHON_FILE_OPS.test(afterEval)
    ) {
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

// An interpreter fed from a heredoc (`python - <<'PY'`) was the hole: the -c/-e patterns
// above never see it, so a multi-line program that rewrites files passed as an ordinary
// shell command. Two independent rules, because size and intent catch different misses —
// a 200-line computation is a program worth questioning, and an 8-line one that calls
// writeFileSync is doing Write's job however short it is.
const HEREDOC_INTERPRETER_PATTERN =
  /\b(?:python3?|node|deno|bun|perl|ruby|php)\b[^\n<]*<<-?\s*['"]?(\w+)['"]?/i;

// Two small patterns rather than one alternation, which exceeded the linter's complexity
// budget: an explicit write API, or a file opened in a writing mode.
const SCRIPT_WRITE_API_PATTERN =
  /\bwriteFileSync\b|\bappendFileSync\b|\bwrite_text\b|\.write\s*\(|\bshutil\.(?:copy|move)\b/i;
const SCRIPT_WRITE_MODE_PATTERN = /\bopen\s*\([^)]*['"][wa]\+?['"]/i;

function writesFiles(body) {
  return (
    SCRIPT_WRITE_API_PATTERN.test(body) || SCRIPT_WRITE_MODE_PATTERN.test(body)
  );
}

function heredocBodyOf(command, terminator) {
  const lines = String(command).split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(`<<`));
  if (start === -1) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === terminator) break;
    body.push(line);
  }
  return body.join('\n');
}

function checkHeredocScript(command, maxLines) {
  const match = HEREDOC_INTERPRETER_PATTERN.exec(command);
  if (!match) return;
  const body = heredocBodyOf(command, match[1]);
  if (!body.trim()) return;

  if (writesFiles(body)) {
    deny(
      CONFIG_KEY,
      `${REMEDY} (detected: an inline ${match[0].split(/\s/)[0]} script that writes files — ` +
        'Write creates a file and Edit does exact replacement, with no quoting or encoding ' +
        'layer to corrupt the content)',
    );
  }

  const lineCount = body.split('\n').length;
  if (lineCount > maxLines) {
    deny(
      CONFIG_KEY,
      `${REMEDY} (detected: a ${lineCount}-line inline script, over the ${maxLines}-line ` +
        'limit — a program this size belongs in a file that can be reviewed and tested, ' +
        'not in a shell command. Raise maxInlineScriptLines if this is genuinely a one-off ' +
        'computation)',
    );
  }
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: { maxInlineScriptLines: 100 },
  },
  ({ toolName, toolInput, parameters }) => {
    if (!toolInGroups(toolName, ['shell'])) return;
    const command = shellCommandOf(toolInput);
    checkCommand(command);
    checkHeredocScript(command, parameters.maxInlineScriptLines);
  },
);
