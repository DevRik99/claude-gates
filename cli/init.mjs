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
import { installPlugin, pluginInstallCommands } from './install.mjs';
import {
  materializeGates,
  plannedChanges,
  revertChanges,
} from './materialize.mjs';
import { loadRegistry, allGates } from './registry.mjs';
import {
  MODES,
  resolveSelection,
  adoptionOf,
  namedGatesFor,
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
    removePrevious: options.removePrevious,
    force: Boolean(options.force),
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

async function askRemovePrevious(io) {
  return bail(
    await io.confirm({
      message:
        'Remove the previous plugin version before installing the new one?',
      initialValue: true,
    }),
  );
}

function stateLabel(value) {
  if (value === 'default') return 'default';
  return value ? 'on' : 'off';
}

function describeChange(change) {
  return `${change.configKey}: ${stateLabel(change.from)} → ${stateLabel(change.to)}`;
}

async function askChanges(io, changes) {
  const approved = bail(
    await io.multiselect({
      message:
        'These gates are already in the file and would change. Keep checked the ones to apply:',
      options: changes.map((change) => ({
        value: change.configKey,
        label: describeChange(change),
      })),
      initialValues: changes.map((change) => change.configKey),
      required: false,
    }),
  );
  return new Set(approved);
}

/** Existing gates only change when the user confirms (or passes --force); never silently. */
async function settleChanges({ io, flags, interactive, existingGates, gates }) {
  const changes = plannedChanges(existingGates, gates);
  if (changes.length === 0) return { gates, kept: [] };
  if (flags.force) return { gates, kept: [] };
  if (interactive) {
    const approved = await askChanges(io, changes);
    const kept = changes.filter((change) => !approved.has(change.configKey));
    return {
      gates: revertChanges(
        gates,
        existingGates,
        kept.map((change) => change.configKey),
      ),
      kept,
    };
  }
  return {
    gates: revertChanges(
      gates,
      existingGates,
      changes.map((change) => change.configKey),
    ),
    kept: changes,
  };
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

/**
 * Installs the gate plugins after the config has been written, unless the user turned
 * everything off or opted out with `--no-install`. Additive: `claude plugin install`
 * merges the gate hooks next to whatever is already configured. If it cannot run, this
 * falls back to printing the manual command. Extracted from `runInit` purely to keep that
 * function's branching within the project's complexity budget — same behavior, same order.
 */
async function installGatesAfterWrite({
  flags,
  gates,
  scope,
  cwd,
  interactive,
  io,
  path,
  merged,
}) {
  const wantsInstall = flags.install !== false && adoptionOf(gates) !== false;
  if (!wantsInstall) {
    io.outro(`Written ${path}.`);
    return { path, config: merged, written: true, installed: false };
  }

  // Default true: a previous plugin version is removed before installing the new one, unless
  // --no-remove-previous turned it off. Only asked when interactive — --yes or no TTY uses the
  // flag/default without a prompt, so scripted and non-interactive runs never block on input.
  const removePrevious =
    flags.removePrevious !== false &&
    (!interactive || (await askRemovePrevious(io)));

  const result = installPlugin(scope, { cwd, removePrevious });
  if (result.installed) {
    io.outro(
      `Written ${path} and installed all plugins (${result.scope} scope). ` +
        'Restart the session (or run /plugin) for the gates to load.',
    );
  } else {
    const manualCommands = pluginInstallCommands()
      .filter((_command, index) => !result.results[index].installed)
      .join('\n  ');
    io.log.warn(
      `Config written, but not every plugin installed automatically (${result.reason}). ` +
        `Install the rest yourself with:\n  ${manualCommands}`,
    );
    io.outro(`Written ${path}.`);
  }
  return { path, config: merged, written: true, installed: result.installed };
}

function enabledOfEntry(entry, fallback) {
  if (typeof entry === 'boolean') return entry;
  if (entry && typeof entry === 'object') return entry.enabled !== false;
  return fallback;
}

function adoptionOfEntries(registry, gateEntries) {
  const map = {};
  for (const gate of allGates(registry))
    map[gate.configKey] = enabledOfEntry(
      gateEntries[gate.configKey],
      gate.default,
    );
  return adoptionOf(map);
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

  const existingGates = existing.data.gates ?? {};
  const settled = await settleChanges({
    io,
    flags,
    interactive,
    existingGates,
    gates: materializeGates(
      registry,
      gates,
      existingGates,
      mode,
      namedGatesFor(registry, mode, picks),
    ),
  });
  const merged = mergeConfig(existing.data, {
    adopted: adoptionOfEntries(registry, settled.gates),
    gates: settled.gates,
    gateVersion: registry.gateVersion,
  });

  io.note(renderSummary(registry, gates), `Selection (${scope}) → ${path}`);
  if (settled.kept.length > 0) {
    io.log.warn(
      `Kept as they were (not confirmed): ${settled.kept.map(describeChange).join('; ')}. ` +
        'Use `claude-gates enable|disable <gate>` or re-run with --force to apply.',
    );
  }

  if (flags.dryRun) {
    io.outro('Dry run: nothing written.');
    return { path, config: merged, written: false };
  }

  if (interactive) await confirmWrite(io, existing.exists);

  writeConfig(path, merged);

  return installGatesAfterWrite({
    flags,
    gates,
    scope,
    cwd,
    interactive,
    io,
    path,
    merged,
  });
}
