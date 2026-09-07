// `claude-gates init` — the interactive flow: scope → mode → picks → confirm → write.
// Every decision can also be passed as a flag so CI and scripts can run it without a TTY.

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as prompts from '@clack/prompts';
import { mergeBlock, readClaudeMd, renderBlock } from './claude-md.mjs';
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
  newGatesFor,
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
  {
    value: MODES.NEW,
    label: 'Only what is new',
    hint: 'lists just the gates this config has never decided about',
  },
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
  new: MODES.NEW,
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

/**
 * The "only what is new" prompt: the same grouped picker as `askGates`, but built from
 * `newGatesFor` so nothing already decided in this config is even shown — the point is to
 * adopt what a release added without re-answering, or accidentally flipping, the rest.
 * Everything starts checked when it is a recommended default, matching the other pickers.
 */
async function askNewGates(io, registry, existingGates) {
  const fresh = newGatesFor(registry, existingGates);
  if (fresh.length === 0) return { picks: [], none: true };

  const options = {};
  for (const gate of fresh) {
    const family = registry.families.find((entry) => entry.id === gate.family);
    const label = family?.name ?? gate.family;
    options[label] ??= [];
    options[label].push({
      value: gate.id,
      label: gate.id,
      hint: gate.description,
    });
  }
  const picks = bail(
    await io.groupMultiselect({
      message: `${fresh.length} gate(s) this config has never decided about (space to toggle, enter to confirm)`,
      options,
      initialValues: fresh
        .filter((gate) => gate.default)
        .map((gate) => gate.id),
      required: false,
    }),
  );
  return { picks, none: false };
}

/** `claude plugin install <plugin>@<marketplace>`, read from the marketplace manifest, never hard-coded. */

/** Fills in whatever the flags left undecided, asking only when there is a TTY. */
/**
 * Fills `picks.gates` for the "only what is new" mode. Needs the config that is about to be
 * written, so it is resolved here rather than in the generic prompt step: the list of new
 * gates is a function of what that file already decided. Scripted runs (`--new --yes`) take
 * the new gates that are recommended defaults — "adopt what the release added" is the only
 * sensible unattended reading of the mode.
 */
async function decideNewPicks(io, registry, path, interactive) {
  const existingGates = readConfig(path).data.gates ?? {};
  if (!interactive)
    return {
      picks: newGatesFor(registry, existingGates)
        .filter((gate) => gate.default)
        .map((gate) => gate.id),
      none: newGatesFor(registry, existingGates).length === 0,
    };
  return askNewGates(io, registry, existingGates);
}

/** Fills the picks the FAMILIES/GRANULAR modes need, when a flag did not already supply them. */
async function askPicksFor(mode, registry, picks, interactive) {
  if (!interactive) return;
  if (mode === MODES.FAMILIES && picks.families.length === 0)
    picks.families = await askFamilies(registry);
  if (mode === MODES.GRANULAR && picks.gates.length === 0)
    picks.gates = await askGates(registry);
}

async function decide(flags, registry, cwd, interactive, io) {
  const scope =
    flags.scope ?? (interactive ? await askScope(cwd) : SCOPES.PROJECT);
  const mode = flags.mode ?? (interactive ? await askMode() : MODES.DEFAULTS);
  const picks = { families: flags.families, gates: flags.gates };
  await askPicksFor(mode, registry, picks, interactive);

  if (mode !== MODES.NEW || picks.gates.length > 0)
    return { scope, mode, picks, nothingNew: false };

  const fresh = await decideNewPicks(
    io,
    registry,
    configPathFor(scope, { cwd }),
    interactive,
  );
  picks.gates = fresh.picks;
  return { scope, mode, picks, nothingNew: fresh.none };
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
// Because a global rule written into a project's CLAUDE.md (or the reverse) would align the
// model in the wrong place, the block goes to the one matching the config's OWN scope.
function claudeMdPathFor(scope, cwd) {
  return scope === SCOPES.GLOBAL
    ? join(homedir(), '.claude', 'CLAUDE.md')
    : join(cwd, 'CLAUDE.md');
}

/**
 * Puts what the ACTIVE gates expect into CLAUDE.md, so the model arrives already aligned
 * instead of learning each rule by being denied. It fails soft on purpose: the config is
 * already written and the gates already work, so being unable to touch a file the user owns
 * warns and continues rather than aborting the init.
 */
function alignClaudeMd(registry, gatesConfig, { scope, cwd, io }) {
  const path = claudeMdPathFor(scope, cwd);
  try {
    const merged = mergeBlock(
      readClaudeMd(path),
      renderBlock(registry, gatesConfig),
    );
    writeFileSync(path, merged, 'utf8');
    return path;
  } catch (error) {
    io.log.warn(
      `Could not align ${path} (${error.message}). The gates are configured anyway.`,
    );
    return null;
  }
}

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

/**
 * `stdin.isTTY` alone is not enough to prompt: a stream can carry the flag and still not be a
 * tty.ReadStream that takes raw mode (a bare VPS shell, `docker exec` without -t, a web
 * terminal), and @clack then paints a picker whose keys do nothing — the run looks frozen
 * right after the intro with no way out but Ctrl-C. Both ends have to be a real terminal,
 * because falling back to the scripted path is always recoverable and a hang never is.
 */
export function terminalCanPrompt(
  stdin = process.stdin,
  stdout = process.stdout,
) {
  return Boolean(
    stdin?.isTTY && stdout?.isTTY && typeof stdin.setRawMode === 'function',
  );
}

export async function runInit(
  options,
  { cwd = process.cwd(), io = prompts } = {},
) {
  const flags = normalizeOptions(options);
  const registry = loadRegistry();
  const interactive = !flags.yes && terminalCanPrompt();

  if (interactive) io.intro('claude-gates');
  else if (!flags.yes) {
    io.log.info(
      'No terminal to prompt on, so nothing is being asked. Running scripted with what the ' +
        'flags decided. Choose explicitly with --project|--global, --defaults|--all|--new|' +
        '--families <ids>|--gates <ids>, and add --yes to silence this.',
    );
  }

  const { scope, mode, picks, nothingNew } = await decide(
    flags,
    registry,
    cwd,
    interactive,
    io,
  );
  if (nothingNew) {
    io.outro(
      'Nothing new: this config already decides about every gate in the registry.',
    );
    return {
      path: configPathFor(scope, { cwd }),
      config: null,
      written: false,
    };
  }
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
  alignClaudeMd(registry, settled.gates, { scope, cwd, io });

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
