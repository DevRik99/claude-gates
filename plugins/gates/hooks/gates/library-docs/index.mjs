import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { extname, isAbsolute, join, relative } from 'node:path';
import { projectRootOf } from '../../lib/config.mjs';
import {
  deny,
  runGate,
  shellCommandOf,
  shellWrittenPaths,
  toolInGroups,
  writtenContentOf,
  writtenPathOf,
} from '../../lib/hook-io.mjs';
import {
  CONTEXT7_SERVERS,
  ENGRAM_SERVERS,
  mcpServerAvailable,
} from '../../lib/mcp-servers.mjs';
import { readSessionState } from '../../lib/session-state.mjs';

export const GATE_ID = 'library-docs';
export const CONFIG_KEY = 'requireDocsBeforeUsingNewLibrary';

const DEFAULT_CODE_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.py',
];
const DEFAULT_IGNORED_PACKAGES = [];
const ALL_INSTALLED = Object.freeze({ engram: true, context7: true });
const DEFAULT_MAX_SCAN_FILES = 500;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'out',
  'vendor',
  '.ai',
]);
const NODE_BUILTINS = new Set(
  builtinModules.map((name) => name.replace(/^node:/, '')),
);
const PYTHON_STDLIB = new Set(
  (
    'os sys re json pathlib typing datetime time math random subprocess collections itertools ' +
    'functools logging unittest dataclasses enum io shutil tempfile argparse asyncio threading ' +
    'socket http urllib csv hashlib base64 uuid copy abc contextlib glob string textwrap ' +
    'statistics decimal fractions pprint traceback warnings inspect importlib pickle sqlite3 ' +
    'xml html email struct queue signal platform getpass secrets zipfile tarfile gzip ' +
    'configparser operator heapq bisect array weakref types numbers cmath ast dis gc atexit ' +
    'select ssl ftplib smtplib mimetypes unicodedata locale gettext calendar zoneinfo ' +
    'concurrent multiprocessing builtins __future__ dataclasses'
  ).split(' '),
);

const JS_IMPORT_PATTERNS = [
  /\bimport\s+['"]([^'"\n]+)['"]/g,
  /\bfrom\s+['"]([^'"\n]+)['"]/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const PY_IMPORT_LINE = /^import\s+([\w.]+)/;
const PY_FROM_LINE = /^from\s+([\w.]+)\s+import\b/;

function pythonSpecifiers(content) {
  const found = [];
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = PY_IMPORT_LINE.exec(line) ?? PY_FROM_LINE.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

function javascriptSpecifiers(content) {
  const found = [];
  for (const pattern of JS_IMPORT_PATTERNS) {
    for (const match of String(content ?? '').matchAll(pattern))
      found.push(match[1]);
  }
  return found;
}

function packageOf(specifier, isPython) {
  if (isPython) return specifier.split('.')[0];
  if (specifier.startsWith('@'))
    return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

// `@/x` and `~/x` are the path aliases every Vite/Nuxt/Vue project ships with, not npm
// packages: an npm scope is `@scope/name` and can never be empty, and `~` is not a scope at
// all. Reading them as dependencies made the gate demand docs for the project's own files.
const PATH_ALIAS_PATTERN = /^(?:@\/|~($|[/\\]))/;

function isExternal(specifier, isPython) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/'))
    return false;
  if (!isPython && PATH_ALIAS_PATTERN.test(specifier)) return false;
  if (specifier.startsWith('node:') || specifier.startsWith('#')) return false;
  if (isPython) return !PYTHON_STDLIB.has(packageOf(specifier, true));
  if (NODE_BUILTINS.has(packageOf(specifier, false))) return false;
  if (/^[a-z]:[\\/]/i.test(specifier)) return false;
  return true;
}

export function importedPackagesOf(content, filePath) {
  const isPython = extname(filePath).toLowerCase() === '.py';
  const specifiers = isPython
    ? pythonSpecifiers(content)
    : javascriptSpecifiers(content);
  const packages = new Set();
  for (const raw of specifiers) {
    const specifier = raw.trim();
    if (isExternal(specifier, isPython))
      packages.add(packageOf(specifier, isPython));
  }
  return [...packages];
}

function* codeFiles(directory, extensions, budget) {
  const stack = [directory];
  while (stack.length > 0 && budget.left > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.'))
          stack.push(path);
      } else if (extensions.includes(extname(entry.name).toLowerCase())) {
        budget.left -= 1;
        yield path;
        if (budget.left === 0) return;
      }
    }
  }
}

function packagesUsedElsewhere(root, writtenPath, extensions, maxFiles) {
  const used = new Set();
  const budget = { left: maxFiles };
  for (const file of codeFiles(root, extensions, budget)) {
    if (relative(file, writtenPath) === '') continue;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const name of importedPackagesOf(content, file)) used.add(name);
  }
  return used;
}

function existingImports(absolutePath) {
  if (!existsSync(absolutePath)) return new Set();
  try {
    if (!statSync(absolutePath).isFile()) return new Set();
    return new Set(
      importedPackagesOf(readFileSync(absolutePath, 'utf8'), absolutePath),
    );
  } catch {
    return new Set();
  }
}

function tokensOf(name) {
  const lowered = name.toLowerCase();
  const short = lowered.startsWith('@') ? lowered.split('/')[1] : lowered;
  return [lowered, short, short.replace(/[-_.]/g, '')].filter(Boolean);
}

function mentions(list, name) {
  const haystack = list.map((entry) => String(entry).toLowerCase());
  return tokensOf(name).some((token) =>
    haystack.some((entry) => entry.includes(token)),
  );
}

// Because a demand nothing can meet is worse than no demand at all, what counts as "known"
// narrows to the servers that exist: no engram means no mem_save to ask for, and no
// context7 means engram alone has to answer.
export function knowledgeStatus(state, name, installed = ALL_INSTALLED) {
  const searched = mentions(state.memSearchHits ?? [], name);
  const documentation = mentions(state.context7Lookups ?? [], name);
  const saved = mentions(state.memSaves ?? [], name);
  const known = installed.engram
    ? searched || (installed.context7 && documentation && saved)
    : documentation;
  return { searched, documentation, saved, known };
}

const HEREDOC_START_PATTERN = /<<-?\s*['"]?(\w+)['"]?(?:\s*>{1,2}\s*\S+)?$/;

function extractHeredocBodies(command) {
  const lines = String(command).split(/\r?\n/);
  const bodies = [];
  let collecting = null;
  let body = [];
  for (const line of lines) {
    if (collecting) {
      if (line.trim() === collecting) {
        bodies.push(body.join('\n'));
        collecting = null;
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }
    const match = HEREDOC_START_PATTERN.exec(line.trimEnd());
    if (match) {
      collecting = match[1];
      body = [];
    }
  }
  return bodies;
}

function remedyFor(name, status, installed) {
  const steps = [];
  if (installed.engram && !status.searched && !status.documentation)
    steps.push(`1) mem_search "${name} usage" (engram is the first source)`);
  if (installed.context7 && !status.documentation)
    steps.push(
      `2) ${installed.engram ? 'if engram has nothing: ' : ''}context7 resolve-library-id "${name}" then get-library-docs for the API you need`,
    );
  if (installed.engram && status.documentation && !status.saved)
    steps.push(
      `3) mem_save what you learned about ${name} (title mentioning "${name}") so the next session reads it from engram`,
    );
  return steps.join('; ');
}

runGate(
  {
    id: GATE_ID,
    configKey: CONFIG_KEY,
    enabledByDefault: true,
    defaultParams: {
      codeExtensions: DEFAULT_CODE_EXTENSIONS,
      ignoredPackages: DEFAULT_IGNORED_PACKAGES,
      maxScanFiles: DEFAULT_MAX_SCAN_FILES,
    },
  },
  ({ toolName, toolInput, sessionId, parameters, cwd }) => {
    const isWrite = toolInGroups(toolName, ['write']);
    const isShell = toolInGroups(toolName, ['shell']);
    if (!isWrite && !isShell) return;

    const root = projectRootOf(cwd) ?? cwd;
    const installed = {
      engram: mcpServerAvailable(ENGRAM_SERVERS, root),
      context7: mcpServerAvailable(CONTEXT7_SERVERS, root),
    };
    if (!installed.engram && !installed.context7) return;

    const ignored = new Set(
      parameters.ignoredPackages.map((name) => String(name).toLowerCase()),
    );

    // Collect { path, content } pairs to check.
    const targets = [];

    if (isWrite) {
      const writtenPath = writtenPathOf(toolInput);
      if (
        writtenPath &&
        parameters.codeExtensions.includes(extname(writtenPath).toLowerCase())
      ) {
        targets.push({
          path: writtenPath,
          content: writtenContentOf(toolInput),
        });
      }
    }

    if (isShell) {
      const command = shellCommandOf(toolInput);
      const writtenPaths = shellWrittenPaths(command).filter((path) =>
        parameters.codeExtensions.includes(extname(path).toLowerCase()),
      );
      if (writtenPaths.length > 0) {
        const heredocBodies = extractHeredocBodies(command);
        const allContent = heredocBodies.join('\n');
        for (const path of writtenPaths) {
          targets.push({ path, content: allContent || null });
        }
      }
    }

    if (targets.length === 0) return;

    const allBlocked = [];
    const state = readSessionState(GATE_ID, sessionId, {}, { cwd });

    for (const { path, content } of targets) {
      const absolutePath = isAbsolute(path) ? path : join(root, path);

      if (content === null) {
        // Shell command writes a code file but content cannot be inspected (no heredoc).
        deny(
          CONFIG_KEY,
          `This shell command writes to ${path} (a code file) via redirection. Use the Write ` +
            'tool for code files so library usage can be verified. Heredocs are extractable ' +
            'but plain redirections are opaque to this gate.',
        );
      }

      const already = existingImports(absolutePath);
      const candidates = importedPackagesOf(content, path).filter(
        (name) => !already.has(name) && !ignored.has(name.toLowerCase()),
      );
      if (candidates.length === 0) continue;

      const usedElsewhere = packagesUsedElsewhere(
        root,
        absolutePath,
        parameters.codeExtensions,
        parameters.maxScanFiles,
      );
      const unknown = candidates.filter((name) => !usedElsewhere.has(name));
      if (unknown.length === 0) continue;

      const blocked = unknown
        .map((name) => ({
          name,
          status: knowledgeStatus(state, name, installed),
        }))
        .filter((entry) => !entry.status.known);
      allBlocked.push(...blocked);
    }

    if (allBlocked.length === 0) return;
    const lines = allBlocked.map(
      (entry) =>
        `${entry.name}: ${remedyFor(entry.name, entry.status, installed)}`,
    );
    deny(
      CONFIG_KEY,
      `This ${isShell ? 'shell command' : 'write'} introduces ${allBlocked.length} package(s) this project does not use ` +
        `anywhere yet, and nothing in this session shows how to use them. Do not guess an API. ` +
        `${lines.join(' | ')}. Then retry${isShell ? ' using the Write tool' : ''}.`,
    );
  },
);
