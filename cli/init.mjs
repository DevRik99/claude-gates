// `claude-gates init` — the interactive flow: scope → mode → picks → confirm → write.
// Every decision can also be passed as a flag so CI and scripts can run it without a TTY.

import * as prompts from '@clack/prompts';
import {
  SCOPES,
  configPathFor,
  readConfig,
  mergeConfig,
  writeConfig,
} from './config.mjs';
import { EXIT_CODE } from './constants.mjs';
import { installPlugin, pluginInstallCommand } from './install.mjs';
import { materializeGates } from './materialize.mjs';
import { loadRegistry, allGates } from './registry.mjs';
import {
  MODES,
  resolveSelection,
  adoptionOf,
  summarize,
} from './selection.mjs';

const MODE_OPTIONS = [
  {
    value: MODES.DEFAULTS,
    label: 'Recommended defaults',
    hint: 'gates marked default in the registry',
  },
  { value: MODES.ALL, label: 'Everything', hint: 'every gate in every family' },
  { value: MODES.FAMILIES, label: 'By family', hint: 'pick whole families' },
  { value: MODES.GRANULAR, label: 'Granular', hint: 'pick individual gates' },
  {
    value: MODES.NONE,
    label: 'Nothing',
    hint: "record a 'no' so you are not asked again",
  },
];

/** commander option name → selection mode */
const MODE_BY_OPTION = {
  defaults: MODES.DEFAULTS,
  all: MODES.ALL,
  none: MODES.NONE,
  families: MODES.FAMILIES,
  gates: MODES.GRANULAR,
};

/**
 * Turns commander's options object into the decisions `runInit` needs.
 * `scope`/`mode` stay `null` when no flag decided them (prompted later).
 */
export function normalizeOptions(options = {}) {
  const modeFlags = Object.keys(MODE_BY_OPTION).filter((name) => options[name]);
  if (modeFlags.length > 1)
    throw new Error(`Pick one of --${modeFlags.join(', --')}`);
  if (options.project && options.global)
    throw new Error('Pick one of --project, --global');

  let scope = null;
  if (options.project) scope = SCOPES.PROJECT;
  if (options.global) scope = SCOPES.GLOBAL;

  return {
    scope,
    mode: modeFlags.length === 1 ? MODE_BY_OPTION[modeFlags[0]] : null,
    families: Array.isArray(options.families) ? options.families : [],
    gates: Array.isArray(options.gates) ? options.gates : [],
    yes: Boolean(options.yes),
    dryRun: Boolean(options.dryRun),
    install: options.install,
  };
}

function bail(value) {
  if (prompts.isCancel(value)) {
    prompts.cancel('Nothing written.');
    process.exit(EXIT_CODE.FAILURE);
  }
  return value;
}

async function askScope(cwd) {
  return bail(
    await prompts.select({
      message: 'Where should these gates apply?',
      options: [
        {
          value: SCOPES.PROJECT,
          label: 'This project',
          hint: configPathFor(SCOPES.PROJECT, { cwd }),
        },
        {
          value: SCOPES.GLOBAL,
          label: 'Globally (fallback for every project)',
          hint: configPathFor(SCOPES.GLOBAL),
        },
      ],
    }),
  );
}

async function askMode() {
  return bail(
    await prompts.select({
      message: 'What do you want to adopt?',
      options: MODE_OPTIONS,
    }),
  );
}

async function askFamilies(registry) {
  return bail(
    await prompts.multiselect({
      message: 'Pick families (space to toggle, enter to confirm)',
      options: registry.families.map((family) => ({
        value: family.id,
        label: family.name,
        hint: family.description,
      })),
      initialValues: registry.families
        .filter((family) => family.gates.some((gate) => gate.default))
        .map((family) => family.id),
      required: false,
    }),
  );
}

async function askGates(registry) {
  const options = {};
  for (const family of registry.families) {
    options[family.name] = family.gates.map((gate) => ({
      value: gate.id,
      label: gate.id,
      hint: gate.description,
    }));
  }
  return bail(
    await prompts.groupMultiselect({
      message: 'Pick gates (space to toggle, enter to confirm)',
      options,
      initialValues: allGates(registry)
        .filter((gate) => gate.default)
        .map((gate) => gate.id),
      required: false,
    }),
  );
}

/** `claude plugin install <plugin>@<marketplace>`, read from the marketplace manifest, never hard-coded. */

/** Fills in whatever the flags left undecided, asking only when there is a TTY. */
async function decide(flags, registry, cwd, interactive) {
  const scope =
    flags.scope ?? (interactive ? await askScope(cwd) : SCOPES.PROJECT);
  const mode = flags.mode ?? (interactive ? await askMode() : MODES.DEFAULTS);
  const picks = { families: flags.families, gates: flags.gates };
  if (interactive && mode === MODES.FAMILIES && picks.families.length === 0) {
    picks.families = await askFamilies(registry);
  }
  if (interactive && mode === MODES.GRANULAR && picks.gates.length === 0) {
    picks.gates = await askGates(registry);
  }
  return { scope, mode, picks };
}

function renderSummary(registry, gatesMap) {
  return summarize(registry, gatesMap)
    .map((row) => {
      const list = row.enabled.length > 0 ? ` — ${row.enabled.join(', ')}` : '';
      return `${row.name}: ${row.enabled.length}/${row.total}${list}`;
    })
    .join('\n');
}

async function confirmWrite(io, fileExists) {
  const confirmed = bail(
    await io.confirm({
      message: fileExists
        ? 'File exists. Merge this selection into it?'
        : 'Write this file?',
    }),
  );
  if (!confirmed) {
    io.cancel('Nothing written.');
    process.exit(EXIT_CODE.FAILURE);
  }
}

export async function runInit(
  options,
  { cwd = process.cwd(), io = prompts } = {},
) {
  const flags = normalizeOptions(options);
  const registry = loadRegistry();
  const interactive = !flags.yes && Boolean(process.stdin.isTTY);

  if (interactive) io.intro('claude-gates');

  const { scope, mode, picks } = await decide(
    flags,
    registry,
    cwd,
    interactive,
  );
  const gates = resolveSelection(registry, mode, picks);
  const path = configPathFor(scope, { cwd });
  const existing = readConfig(path);

  if (existing.corrupt) {
    io.log.error(
      `${path} exists but is not valid JSON. Fix or remove it first; nothing written.`,
    );
    process.exit(EXIT_CODE.FAILURE);
  }

  const merged = mergeConfig(existing.data, {
    adopted: adoptionOf(gates),
    gates: materializeGates(registry, gates),
    gateVersion: registry.gateVersion,
  });

  io.note(renderSummary(registry, gates), `Selection (${scope}) → ${path}`);

  if (flags.dryRun) {
    io.outro('Dry run: nothing written.');
    return { path, config: merged, written: false };
  }

  if (interactive) await confirmWrite(io, existing.exists);

  writeConfig(path, merged);

  // Install based on the selection, unless the user turned everything off or opted out.
  // Additive: `claude plugin install` merges the gate hooks next to whatever is already
  // configured. If it cannot run, we fall back to printing the manual command.
  const wantsInstall = flags.install !== false && adoptionOf(gates) !== false;
  if (!wantsInstall) {
    io.outro(`Written ${path}.`);
    return { path, config: merged, written: true, installed: false };
  }

  const result = installPlugin(scope, { cwd });
  if (result.installed) {
    io.outro(
      `Written ${path} and installed the plugin (${result.scope} scope). ` +
        'Restart the session (or run /plugin) for the gates to load.',
    );
  } else {
    io.log.warn(
      `Config written, but the plugin was not installed automatically (${result.reason}). ` +
        `Install it yourself with: ${pluginInstallCommand()}`,
    );
    io.outro(`Written ${path}.`);
  }
  return { path, config: merged, written: true, installed: result.installed };
}
