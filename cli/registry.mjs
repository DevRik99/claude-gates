// Loads and validates registry.json — the catalog that menus, config and hooks derive from.
// Validation is a zod schema so the shape is declared once and errors are uniform.
// Fails loudly on a corrupt catalog: a menu built on invalid data would write a
// configuration that no gate recognizes.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { REGISTRY_PATH } from './constants.mjs';

export const HOOK_EVENTS = [
  'PreToolUse',
  'SessionStart',
  'PostToolUse',
  'Stop',
  'UserPromptSubmit',
];
export const TOOL_GROUPS = [
  'write',
  'shell',
  'delegation',
  'execution',
  'question',
];

/** The kinds of value a gate param can take, so the CLI can describe and validate it. */
export const PARAM_TYPES = ['string', 'number', 'boolean', 'string[]'];

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CONFIG_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// A gate's script is a path relative to the plugin's hooks/ directory: `gates/x.mjs`
// (a PreToolUse gate) or `x.mjs` (a session hook). Never absolute, never climbing out.
const SCRIPT_PATTERN = /^(?!\/|[A-Za-z]:|\.\.\/)[\w./-]+\.mjs$/;

/**
 * A configurable param a project may override. The registry declares that the param
 * EXISTS and its type; the default VALUE lives in the gate's own source, so the user
 * reads it there and knows exactly what a project override replaces.
 */
const parameterSchema = z.object({
  name: z.string().regex(CONFIG_KEY_PATTERN, 'param name must be camelCase'),
  type: z.enum(PARAM_TYPES),
  description: z.string().min(1),
});

const gateSchema = z.object({
  id: z.string().regex(ID_PATTERN, 'gate id must be kebab-case'),
  configKey: z
    .string()
    .regex(CONFIG_KEY_PATTERN, 'configKey must be camelCase'),
  default: z.boolean(),
  event: z.enum(HOOK_EVENTS),
  tools: z.array(z.enum(TOOL_GROUPS)),
  script: z
    .string()
    .regex(SCRIPT_PATTERN, 'script must be an .mjs path relative to hooks/'),
  description: z.string().min(1),
  // Optional: a gate with no configurable params omits it.
  params: z.array(parameterSchema).optional(),
});

const familySchema = z.object({
  id: z.string().regex(ID_PATTERN, 'family id must be kebab-case'),
  name: z.string().min(1),
  description: z.string().min(1),
  // Which plugin's hooks/ directory the family's gate scripts resolve against. Optional so
  // existing families need no change: absent means the original 'gates' plugin.
  plugin: z
    .string()
    .regex(ID_PATTERN, 'plugin id must be kebab-case')
    .optional(),
  gates: z.array(gateSchema).min(1),
});

function duplicatesIn(items) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    if (seen.has(item)) duplicates.add(item);
    seen.add(item);
  }
  return [...duplicates];
}

/** Uniqueness across families is not expressible per-field, so it is a second pass. */
function duplicateProblems(candidate) {
  const families = Array.isArray(candidate?.families) ? candidate.families : [];
  const gates = families.flatMap((family) =>
    Array.isArray(family?.gates) ? family.gates : [],
  );
  return [
    ...duplicatesIn(families.map((family) => family?.id)).map(
      (id) => `duplicate family id: ${id}`,
    ),
    ...duplicatesIn(gates.map((gate) => gate?.id)).map(
      (id) => `duplicate gate id: ${id}`,
    ),
    ...duplicatesIn(gates.map((gate) => gate?.configKey)).map(
      (key) => `duplicate configKey: ${key}`,
    ),
  ];
}

export const registrySchema = z.object({
  gateVersion: z.string().regex(VERSION_PATTERN, 'gateVersion must be x.y.z'),
  families: z.array(familySchema).min(1),
});

/** Returns a list of human-readable problems; empty when the registry is valid. */
export function validateRegistry(candidate) {
  const result = registrySchema.safeParse(candidate);
  const schemaProblems = result.success
    ? []
    : result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
  return [...schemaProblems, ...duplicateProblems(candidate)];
}

export function loadRegistry(path = REGISTRY_PATH) {
  const candidate = JSON.parse(readFileSync(path, 'utf8'));
  const problems = validateRegistry(candidate);
  if (problems.length > 0) {
    throw new Error(`registry.json is invalid:\n- ${problems.join('\n- ')}`);
  }
  return candidate;
}

const DEFAULT_PLUGIN = 'gates';

export function allGates(registry) {
  return registry.families.flatMap((family) =>
    family.gates.map((gate) => ({
      ...gate,
      family: family.id,
      plugin: family.plugin ?? DEFAULT_PLUGIN,
    })),
  );
}
