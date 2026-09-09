// adversarial-tests:allow — comment-ok: because this file is the gate's behavior suite,
// one case per evidence path (engram hit, engram miss, context7 + save, ignored package).
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isDeny,
  makeProject,
  messageOf,
  runGateProcess,
  withSession,
  write,
} from '../../lib/testing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'index.mjs');
const TRACK = join(HERE, 'track.mjs');

let counter = 0;
function freshSession() {
  counter += 1;
  return `library-docs-test-${process.pid}-${counter}`;
}

const ZOD_FILE =
  "import { z } from 'zod';\nexport const schema = z.object({});\n";

// Because the gate stands down where neither server is declared, every project here
// declares both: what is under test is the evidence rule, not the absence handling.
const MCP_JSON = JSON.stringify({
  mcpServers: { engram: { command: 'engram' }, context7: { command: 'c7' } },
});
const withServers = (files = {}) => ({ '.mcp.json': MCP_JSON, ...files });

function memSearch(query, response) {
  return {
    tool_name: 'mcp__engram__mem_search',
    tool_input: { query },
    tool_response: response,
  };
}
function context7(libraryName) {
  return {
    tool_name: 'mcp__context7__get-library-docs',
    tool_input: { context7CompatibleLibraryID: `/example/${libraryName}` },
    tool_response: 'docs...',
  };
}
function memSave(title) {
  return {
    tool_name: 'mcp__engram__mem_save',
    tool_input: { title, content: 'how it works' },
    tool_response: 'Memory saved',
  };
}

test('denies a write importing a package the project never used without any lookup', () => {
  const project = makeProject({ files: withServers() });
  const result = runGateProcess(
    GATE,
    withSession(
      write(join(project, 'src', 'schema.ts'), ZOD_FILE),
      freshSession(),
    ),
    { project },
  );
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /zod/);
  assert.match(messageOf(result), /mem_search/);
});

test('no engram and no context7: the gate cannot be satisfied, so it does not run', () => {
  const project = makeProject();
  const result = runGateProcess(
    GATE,
    withSession(
      write(join(project, 'src', 'schema.ts'), ZOD_FILE),
      freshSession(),
    ),
    { project },
  );
  assert.equal(result, null);
});

test('allows the import when the package is already imported elsewhere in the project', () => {
  const project = makeProject({
    files: withServers({ 'src/other.ts': "import { z } from 'zod';\n" }),
  });
  const result = runGateProcess(
    GATE,
    withSession(
      write(join(project, 'src', 'schema.ts'), ZOD_FILE),
      freshSession(),
    ),
    { project },
  );
  assert.equal(result, null);
});

test('allows the import after an engram hit about the package', () => {
  const project = makeProject({ files: withServers() });
  const session = freshSession();
  runGateProcess(
    TRACK,
    withSession(
      memSearch('zod usage', 'Found: zod schemas use z.object'),
      session,
    ),
    { project },
  );
  const result = runGateProcess(
    GATE,
    withSession(write(join(project, 'src', 'schema.ts'), ZOD_FILE), session),
    { project },
  );
  assert.equal(result, null);
});

test('an engram miss is not knowledge: context7 docs plus a mem_save are required', () => {
  const project = makeProject({ files: withServers() });
  const session = freshSession();
  runGateProcess(
    TRACK,
    withSession(
      memSearch('zod usage', 'No memories found for: "zod usage"'),
      session,
    ),
    { project },
  );
  const afterMiss = runGateProcess(
    GATE,
    withSession(write(join(project, 'src', 'schema.ts'), ZOD_FILE), session),
    { project },
  );
  assert.ok(isDeny(afterMiss));
  assert.match(messageOf(afterMiss), /context7/);

  runGateProcess(TRACK, withSession(context7('zod'), session), { project });
  const afterDocumentation = runGateProcess(
    GATE,
    withSession(write(join(project, 'src', 'schema.ts'), ZOD_FILE), session),
    { project },
  );
  assert.ok(isDeny(afterDocumentation));
  assert.match(messageOf(afterDocumentation), /mem_save/);

  runGateProcess(
    TRACK,
    withSession(memSave('zod: object schemas and refine'), session),
    { project },
  );
  const afterSave = runGateProcess(
    GATE,
    withSession(write(join(project, 'src', 'schema.ts'), ZOD_FILE), session),
    { project },
  );
  assert.equal(afterSave, null);
});

test('relative imports, node builtins and node: specifiers are never libraries', () => {
  const project = makeProject({ files: withServers() });
  const content =
    "import fs from 'node:fs';\nimport path from 'path';\nimport x from './x.js';\n";
  const result = runGateProcess(
    GATE,
    withSession(write(join(project, 'src', 'a.mjs'), content), freshSession()),
    { project },
  );
  assert.equal(result, null);
});

const importOf = (specifier) =>
  ['import x', 'from', `'${specifier}';\n`].join(' ');

test('the @/ and ~/ path aliases are the project itself, never a library', () => {
  const project = makeProject({ files: withServers() });
  const nuxtAlias = ['~', 'composables', 'x'].join('/');
  const content = ['@/components', '@/types/theme.types', nuxtAlias]
    .map(importOf)
    .join('');
  const result = runGateProcess(
    GATE,
    withSession(write(join(project, 'src', 'a.ts'), content), freshSession()),
    { project },
  );
  assert.equal(result, null);
});

test('a real scoped package is still judged: the alias rule needs an empty scope', () => {
  const project = makeProject({ files: withServers() });
  const result = runGateProcess(
    GATE,
    withSession(
      write(join(project, 'src', 'a.ts'), importOf('@scope/thing')),
      freshSession(),
    ),
    { project },
  );
  assert.ok(isDeny(result));
});

test('an import already present in the file being edited is not new', () => {
  const project = makeProject({
    files: withServers({ 'src/schema.ts': ZOD_FILE }),
  });
  const result = runGateProcess(
    GATE,
    withSession(
      write(
        join(project, 'src', 'schema.ts'),
        `${ZOD_FILE}export const b = 1;\n`,
      ),
      freshSession(),
    ),
    { project },
  );
  assert.equal(result, null);
});

test('python imports are judged the same way', () => {
  const project = makeProject({ files: withServers() });
  const result = runGateProcess(
    GATE,
    withSession(
      write(join(project, 'app.py'), 'import httpx\nfrom os import path\n'),
      freshSession(),
    ),
    { project },
  );
  assert.ok(isDeny(result));
  assert.match(messageOf(result), /httpx/);
  assert.doesNotMatch(messageOf(result), /\bos\b:/);
});

test('ignoredPackages skips a package by name', () => {
  const project = makeProject({
    files: withServers(),
    config: {
      gates: {
        requireDocsBeforeUsingNewLibrary: {
          enabled: true,
          ignoredPackages: ['zod'],
        },
      },
    },
  });
  const result = runGateProcess(
    GATE,
    withSession(
      write(join(project, 'src', 'schema.ts'), ZOD_FILE),
      freshSession(),
    ),
    { project },
  );
  assert.equal(result, null);
});
