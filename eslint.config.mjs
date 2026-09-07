// Ported from forge-backend's eslint.config.mjs and extended for this repo. Plain ESM
// (.mjs), so the TypeScript/Nest layers are dropped; kept: JS base, unicorn,
// unused-imports, cspell, prettier. Added: architectural boundaries, no magic
// numbers, no hard-coded paths, node/import/promise/sonar hygiene.

import cspell from '@cspell/eslint-plugin';
import eslint from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import { flatConfigs as importXFlatConfigs } from 'eslint-plugin-import-x';
import n from 'eslint-plugin-n';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import promise from 'eslint-plugin-promise';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

const MAX_COMPLEXITY = 12;
const MAX_COGNITIVE_COMPLEXITY = 15;
const MAX_LINES_PER_FUNCTION = 80;
const MIN_DUPLICATE_STRING_LENGTH = 3;

/** Numbers that read as themselves and never need a name. */
const SELF_EXPLANATORY_NUMBERS = [-1, 0, 1, 2];

/**
 * A string literal that looks like a filesystem path or a home shortcut is a
 * hard-coded location. Locations belong in a constants module or come from the
 * environment (`CLAUDE_PLUGIN_ROOT`, cwd, homedir()).
 */
// Slashes are escaped because esquery wraps the pattern in /.../.
const HARD_CODED_PATH_PATTERN = String.raw`^([A-Za-z]:[\\\/]|\\\\|\/(Users|home|tmp|etc|var)\/|~[\\\/])`;
const HARD_CODED_PATH_SELECTOR = `Literal[value=/${HARD_CODED_PATH_PATTERN}/]`;
const HARD_CODED_PATH_TEMPLATE_SELECTOR = `TemplateElement[value.raw=/${HARD_CODED_PATH_PATTERN}/]`;

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', '**/__snapshots__/**'],
  },

  eslint.configs.recommended,
  importXFlatConfigs.recommended,
  n.configs['flat/recommended-module'],
  promise.configs['flat/recommended'],
  sonarjs.configs.recommended,

  {
    files: ['**/*.{js,cjs,mjs}'],

    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },

    plugins: {
      '@cspell': cspell,
      unicorn,
      'unused-imports': unusedImports,
      boundaries,
    },

    settings: {
      // ── Architecture ───────────────────────────────────────────────────
      // cli/          npm CLI. May depend on npm packages. Never on the plugin.
      // hooks/lib     shared code for hooks. Node built-ins only (self-contained).
      // hooks/gates   one gate per folder. May import hooks/lib only.
      // hooks/*.mjs   dispatcher + session hooks. May import hooks/lib only.
      // Elements are FOLDERS (v7). Most specific first: the first matching descriptor wins.
      'boundaries/elements': [
        { type: 'cli-tests', pattern: 'cli/__tests__', partialMatch: false },
        { type: 'cli', pattern: 'cli', partialMatch: false },
        {
          type: 'hook-lib-tests',
          pattern: 'plugins/*/hooks/lib/__tests__',
          partialMatch: false,
        },
        {
          type: 'hook-lib',
          pattern: 'plugins/*/hooks/lib',
          partialMatch: false,
        },
        {
          type: 'hook-gate',
          pattern: 'plugins/*/hooks/gates/*',
          partialMatch: false,
        },
        { type: 'hook', pattern: 'plugins/*/hooks', partialMatch: false },
        { type: 'script', pattern: 'scripts', partialMatch: false },
      ],
      'boundaries/ignore': ['**/node_modules/**', 'eslint.config.mjs'],
    },

    rules: {
      // ── Boundaries ─────────────────────────────────────────────────────
      'boundaries/no-unknown-files': 'error',
      'boundaries/no-unknown-dependencies': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          // Needed so { module: { origin: 'external' } } selectors are evaluated.
          checkAllOrigins: true,
          // Policies are evaluated in order; the last matching one wins.
          policies: [
            // Node built-ins are fine everywhere.
            {
              from: {
                element: {
                  type: [
                    'cli',
                    'cli-tests',
                    'hook',
                    'hook-lib',
                    'hook-lib-tests',
                    'hook-gate',
                  ],
                },
              },
              allow: [{ to: { module: { origin: 'core' } } }],
            },
            {
              from: { element: { type: 'cli' } },
              // hook-lib is Node-builtins-only and self-contained (the same reason a hook
              // may depend on it); the CLI's `task` subcommand reuses task-store.mjs from
              // there rather than duplicating its persistence logic.
              allow: [
                { to: { element: { type: 'cli' } } },
                { to: { element: { type: 'hook-lib' } } },
              ],
            },
            {
              from: { element: { type: 'cli-tests' } },
              allow: [{ to: { element: { type: ['cli', 'cli-tests'] } } }],
            },
            {
              from: { element: { type: 'hook-lib' } },
              allow: [{ to: { element: { type: 'hook-lib' } } }],
            },
            {
              from: { element: { type: 'hook-lib-tests' } },
              allow: [
                { to: { element: { type: ['hook-lib', 'hook-lib-tests'] } } },
              ],
            },
            {
              from: { element: { type: 'hook-gate' } },
              allow: [{ to: { element: { type: 'hook-lib' } } }],
            },
            {
              from: { element: { type: 'hook' } },
              allow: [{ to: { element: { type: 'hook-lib' } } }],
            },
            // A dev script (scripts/) is a standalone Node tool: it reads the gate sources and
            // runs their tests. It may use Node built-ins; it must not pull npm packages, same
            // discipline as a hook.
            {
              from: { element: { type: 'script' } },
              allow: [{ to: { module: { origin: 'core' } } }],
            },
            {
              from: { element: { type: 'script' } },
              disallow: [{ to: { module: { origin: 'external' } } }],
            },
            // The CLI may use npm packages; hooks must be self-contained (Node built-ins only).
            {
              from: { element: { type: ['cli', 'cli-tests'] } },
              allow: [{ to: { module: { origin: 'external' } } }],
            },
            {
              from: { element: { type: ['hook', 'hook-lib', 'hook-gate'] } },
              disallow: [{ to: { module: { origin: 'external' } } }],
            },
            // node:test/node:assert resolve as "external" here (the same upstream limitation).
            // Test-only folders get the same external allowance cli-tests already has;
            // production hook code still disallows external deps via the policy above.
            {
              from: {
                element: { type: 'hook-lib-tests' },
              },
              allow: [{ to: { module: { origin: 'external' } } }],
            },
          ],
        },
      ],

      // ── No hard-coded values ───────────────────────────────────────────
      'no-magic-numbers': [
        'error',
        {
          ignore: SELF_EXPLANATORY_NUMBERS,
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          enforceConst: true,
          detectObjects: false,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: HARD_CODED_PATH_SELECTOR,
          message:
            'Hard-coded filesystem path. Build it from a constants module, cwd, homedir() or CLAUDE_PLUGIN_ROOT.',
        },
        {
          selector: HARD_CODED_PATH_TEMPLATE_SELECTOR,
          message:
            'Hard-coded filesystem path in a template. Build it from a constants module, cwd, homedir() or CLAUDE_PLUGIN_ROOT.',
        },
      ],
      'sonarjs/no-duplicate-string': [
        'error',
        { threshold: MIN_DUPLICATE_STRING_LENGTH },
      ],

      // ── unicorn ────────────────────────────────────────────────────────
      'unicorn/name-replacements': 'error',
      'unicorn/no-abusive-eslint-disable': 'error',
      'unicorn/prefer-node-protocol': 'error',

      // ── node / import / promise ────────────────────────────────────────
      'n/no-process-exit': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-missing-import': 'off',
      'import-x/no-unresolved': 'error',
      'import-x/no-cycle': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
          'newlines-between': 'never',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'promise/always-return': 'off',

      // ── sonar ──────────────────────────────────────────────────────────
      'sonarjs/cognitive-complexity': ['warn', MAX_COGNITIVE_COMPLEXITY],
      'sonarjs/no-os-command-from-path': 'off',

      // ── unused ─────────────────────────────────────────────────────────
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],

      // ── core ───────────────────────────────────────────────────────────
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-throw-literal': 'error',
      'no-debugger': 'error',
      'no-console': 'off',
      'no-shadow': 'error',
      camelcase: ['error', { properties: 'never' }],
      complexity: ['warn', MAX_COMPLEXITY],
      'max-lines-per-function': [
        'warn',
        {
          max: MAX_LINES_PER_FUNCTION,
          skipBlankLines: true,
          skipComments: true,
        },
      ],

      '@cspell/spellchecker': [
        'error',
        { checkIdentifiers: true, checkStrings: false, checkComments: false },
      ],
    },
  },

  {
    files: ['cli/**/*.mjs'],
    rules: {
      // A CLI ends the process on purpose; hooks must throw instead (rule stays on there).
      'unicorn/no-process-exit': 'off',
    },
  },

  {
    // Test files, wherever they live: the classic `*.test.mjs` / `__tests__/`, and the
    // per-gate `gates/<name>/test.mjs` sitting next to its gate. Test code imports
    // node:test (which the boundaries plugin misreads as "external"), and its fixtures
    // repeat literals and numbers that would be noise to name.
    files: [
      '**/*.test.mjs',
      '**/__tests__/**/*.mjs',
      'plugins/*/hooks/gates/*/test.mjs',
    ],
    rules: {
      complexity: 'off',
      'max-lines-per-function': 'off',
      'no-magic-numbers': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'boundaries/dependencies': 'off',
    },
  },

  {
    // forge-flow reads forge's SQLite state via node:sqlite, a genuine Node built-in
    // (22.5+) that @boundaries/elements misreads as "external" (its builtinModules list
    // lags), and that `n` still flags as experimental. It is core and npm-free, so the
    // self-contained contract holds; both checks are relaxed only for this gate and its
    // test, which use node:sqlite deliberately.
    // Scoped to the whole gate directory rather than a list of filenames, so a new test
    // beside the gate does not silently fail lint for using the same built-in.
    files: ['plugins/*/hooks/gates/forge-flow/*.mjs'],
    rules: {
      'boundaries/dependencies': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },

  {
    files: ['eslint.config.mjs'],
    rules: {
      'no-magic-numbers': 'off',
      'sonarjs/no-duplicate-string': 'off',
    },
  },

  // Must be last so formatting conflicts are disabled correctly.
  eslintPluginPrettierRecommended,
];
