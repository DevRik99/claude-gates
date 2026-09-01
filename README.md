# claude-gates

**Installable, deterministic gates (hooks) for Claude Code.** They run automatically before
Claude executes a tool and **block or warn** when something breaks a rule: a destructive
command, a write to a protected file, a delegation with no brief, and more. Everything is
**configurable per project** and can be **turned on/off** whenever you want.

The core idea: instead of trusting the model to _remember_ the rules, a **deterministic**
hook enforces them. A `git reset --hard` does not run because the model chose to behave —
it is blocked because a gate intercepts it.

🇪🇸 [Léelo en español](./README.es.md)

---

## Install

Two steps. The **plugin** wires the hooks into Claude Code; the **CLI** picks which gates
run and with what configuration.

```bash
# 1. Register the marketplace and install the plugin (wires the hooks)
claude plugin marketplace add https://github.com/DevRik99/claude-gates
claude plugin install gates@claude-gates

# 2. Choose which gates to adopt (interactive menu) — or use npx without cloning
npx @devrik-tools/claude-gates init
```

Restart the Claude Code session (or run `/plugin`) so the hooks load.

> **Why two things?** The plugin **always ships all 41 gates**; the config decides **which
> ones run**. So you can turn one on without reinstalling — it is one line in a JSON file.

---

## How it works (the model in 30 seconds)

```
Claude is about to use a tool (Write, Bash, Agent…)
        │
        ▼
Claude Code fires the PreToolUse hooks in parallel
        │
        ▼
Each gate that applies (by its "matcher") runs in its own process:
   · reads the payload       · reads its project config
   · if off → exits          · if the rule is broken → DENY (block) or WARN (advise)
        │
        ▼
If any gate blocks, the tool does not run.
```

- **DENY**: the action is deterministically wrong → it is blocked.
- **WARN**: the action needs judgment → the gate injects a note and lets it proceed.
- **Silence**: the common path. A gate never nags when there is nothing to object to.

Every gate is **self-contained** (Node built-ins only, no runtime dependencies), so it
works even if you install one on its own.

---

## The gates (in families)

`[on]` = enabled by default; `[off]` = enable it if you want it.

### 🔒 Security — hard blocks on destructive actions

| Gate                   |     | What it does                                                                                                                                      |
| ---------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash-commands`        | on  | Blocks `git reset --hard`, `rm -rf` over protected areas, force push, and killing processes by name.                                              |
| `block-remote-publish` | on  | Blocks `git push`, `gh pr merge`, `gh release create` without authorization. Set `blockRemotePublish: false` to let the agent publish on its own. |
| `protected-paths`      | on  | Blocks writes to `.env`, lockfiles and the harness itself.                                                                                        |
| `root-whitelist`       | on  | Blocks new root-level files/folders outside a whitelist.                                                                                          |
| `no-blocking`          | off | Blocks `sleep`, `tail -f`, polling loops and foreground servers.                                                                                  |

### 🤝 Delegation — requirements on the brief when delegating to a subagent

| Gate                    |     | What it does                                                                                                           |
| ----------------------- | --- | ---------------------------------------------------------------------------------------------------------------------- |
| `brief-before-delegate` | off | Requires goal, steps and done-when criteria in the prompt.                                                             |
| `intent-flow`           | off | Requires IN SCOPE / OUT OF SCOPE / EDGE CASES sections.                                                                |
| `risk-level`            | off | Requires a declared level (QUESTION/MICRO/STANDARD/HIGH-RISK).                                                         |
| `circuit-breaker`       | off | Cuts the same delegation retried without real changes.                                                                 |
| `no-memory-dependency`  | off | Blocks a brief that relies on the subagent "remembering" the chat (add `memory-not-needed` to allow a false positive). |

### 📋 Spec-driven flow — only relevant if the project adopted spec-driven development

| Gate                      |     | What it does                                                         |
| ------------------------- | --- | -------------------------------------------------------------------- |
| `feature-catalog`         | on  | A single feature in progress; closing requires asserts and review.   |
| `sdd-specs`               | off | Requires non-empty requirements/design/tasks before implementing.    |
| `brief-approved`          | on  | Requires a recorded user approval (`status: approved` + quote) on the cited feature's brief before implementing. |
| `implementation-pipeline` | off | Requires declaring definition → writing → validation → QA → closure. |
| `mandatory-flow`          | off | Requires an active task with a contract before implementing.         |
| `test-matrix`             | off | Requires a test matrix (the types the requirement makes mandatory).  |

### ✨ Quality — code hygiene, diagnosis and language

| Gate                        |     | What it does                                                                                                   |
| --------------------------- | --- | -------------------------------------------------------------------------------------------------------------- |
| `dependency-skills`         | on  | Blocks a new direct dependency with no matching skill (declare it in `depsWithoutOwnApi` if it needs none).    |
| `root-cause-first`          | off | Requires an origin→symptom diagnosis before a patch.                                                           |
| `audit-before-build`        | off | Before a new script/gate, requires stating that nothing existing covers it.                                    |
| `never-assume`              | off | Flags unverified assumptions in briefs and code.                                                               |
| `rule-skill-autodiscovery`  | off | Loads gates the project declares in its `rules/` and `skills/`.                                                |
| `recurrence-lock`           | on  | A second occurrence of a defect class requires its deterministic block.                                        |
| `test-after-implementation` | off | Blocks a test written after its paired implementation (add `test-after-impl:allow` for a regression test).     |
| `no-reconfirm`              | on  | Never re-ask what you already answered.                                                                        |
| `neutral-spanish`           | on  | Blocks voseo or regional lexicon in written text (add `neutral-spanish:allow` for a deliberate quote/fixture). |
| `diagnosis-before-patch`    | on  | Warns when timeouts/retries change without evidence.                                                           |
| `lint-commit`               | off | Blocks `git commit` while the project's lint script fails (autodetects `npm run lint`; silent if none).        |
| `staged-lint`               | off | Blocks `git commit` when the **staged** files fail lint — lints only what you staged, so your change can't add new lint debt while pre-existing debt in untouched files never blocks you. Add `[skip-lint]` for a deliberate exception. |
| `atomic-commit`             | off | Blocks a `git commit` that is not atomic — one mixing more than N natures of change (code/tests/deps/config…) or staging more reviewable files than a commit should carry. Docs/assets/generated aren't counted. Add `[wip]` for a deliberately broad commit. |
| `no-coauthor`               | on  | Blocks a `git commit` carrying an AI/agent attribution trailer (`Co-Authored-By`, `Generated with`, a session trailer). Add `[allow-coauthor]` for one legitimate co-author. |
| `no-lint-suppression`       | on  | Blocks a write that silences the linter/type-checker (`eslint-disable`, `@ts-ignore`, a rule set to `off`) instead of fixing the code. Add `lint-ok: <reason>` on the same line for a documented false positive. |

### 🔎 Tool discovery — don't reinvent the wheel

| Gate                 |     | What it does                                                                                                 |
| -------------------- | --- | ------------------------------------------------------------------------------------------------------------ |
| `reuse-before-build` | off | Before building a tool, consults the project tool map; blocks if you did not audit (local → Context7 → web). |
| `tool-map`           | off | Records discovered tools in `.ai/tool-map.json` so exploration is not repeated.                              |

### 🏭 Forge pipeline — enforces the forge workflow

| Gate         |     | What it does                                                                                                                                                                                            |
| ------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge-flow` | off | In a project that adopted [forge](https://github.com/DevRik99/forge-mcp), blocks editing/running unless an active forge run exists. Closes the hole the MCP cannot: it forces you through the pipeline. |

### 🩺 Session & context — startup checks and capability injection

| Gate             |     | What it does                                                                                                                                                                                          |
| ---------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`         | on  | On session start, runs the environment validator and only speaks on failure.                                                                                                                        |
| `ask-adoption`   | on  | In a project that never answered, makes the assistant ask what to adopt.                                                                                                                            |
| `wiring-check`   | on  | Warns when a registered hook is missing or a script is orphaned.                                                                                                                                     |
| `capability-map` | on | Every `injectEveryMessages` messages (default 10; always on the first run and whenever a capability is added/removed), injects the project's capability catalog — skills, agents/subagents, commands — as compact data, and persists it to `.ai/capability-map.json` (like the tool map). Autosynced from disk. Never blocks. |

---

## Configuration: turn gates on, off, and tune them

Everything lives in one file. **Project overrides global:**

- **Project:** `<root>/.ai/config.json`
- **Global (fallback):** `~/.claude/claude-gates/config.json`

`init` writes the selection there **and materializes each gate's default values**, so you
see and edit every knob:

```json
{
  "adopted": "partial",
  "gateVersion": "3.0.0",
  "gates": {
    "blockDestructiveShellCommands": {
      "enabled": true,
      "rmRfProtectedAreas": ["/", "*", "src", "tests"],
      "denyPatterns": ["git reset --hard", "…"]
    },
    "blockRemotePublish": { "enabled": false },
    "warnNonNeutralSpanish": {
      "enabled": true,
      "regionalMarkers": ["tenés", "podés", "…"],
      "escapeHatch": "neutral-spanish:allow"
    },
    "requireBriefBeforeDelegating": { "enabled": false }
  }
}
```

- **Turn a gate off:** `"enabled": false`. Off instantly, no reinstall.
- **Tune its behavior:** edit its parameters (the whitelist, the patterns, the thresholds).
  What the project declares **replaces** the gate's default.
- A gate absent from the config uses its catalog default. Keys you already had in the file
  (e.g. `autoCommit`) are kept intact.
- **Let the agent push:** set `"blockRemotePublish": { "enabled": false }`. Nothing is
  hardcoded — every gate, remote publish included, obeys this flag.
- **Escape hatches:** a few gates block (deny) but accept an explicit opt-out marker in the
  content/prompt for a legitimate case: `neutral-spanish:allow` (a deliberate regional
  quote), `test-after-impl:allow` (a regression test), `memory-not-needed` (a
  non-memory phrase), `[allow-coauthor]` (one legitimate co-author on a commit),
  `lint-ok: <reason>` (a documented linter false positive), `[skip-lint]` (skip the
  staged-lint check for one commit), `[wip]` (allow one deliberately broad,
  non-atomic commit). `dependency-skills` opts out via its `depsWithoutOwnApi` list.
- **Capability injection:** `capability-map` (on by default) is fully tunable — pick which
  kinds to surface (`"kinds": ["skills", "agents", "commands"]`), cap each blurb
  (`maxClauseChars`, default 120), add extra roots per kind, throttle how often the full
  catalog is re-injected (`injectEveryMessages`, default 10 — the persisted map file itself
  still refreshes every message), or turn off persistence (`"persist": false`) and point the
  map file elsewhere (`mapFile`). Skills are also scanned by default under `~/.agents/skills`,
  `<project>/.agents/skills`, `~/.ai/skills` and `<project>/.ai/skills` (skill-only roots some
  installers use besides `.claude/skills` — no config needed), in addition to any
  `extraSkillsDirs` the project declares. A description too long to fit `maxClauseChars`
  falls back to mechanical word-boundary truncation, but you can hand-write a better one-line
  summary per capability in `~/.claude/blurb-overrides.json` (global) or
  `<project>/<blurbOverridesFile>` (default `.ai/blurb-overrides.json`, project wins per
  key) — a `{ "skill-name": "short summary" }` map, used verbatim instead of the mechanical
  cut. A capability's re-scan is skipped (its blurb reused verbatim) whenever disk is
  unchanged since the last scan (same set of source files, same mtimes); removing a
  skill/agent/command drops its entry from the map on the very next run.

---

## CLI commands

```bash
# Interactive menu: pick plugins, families or gates, per project or global, and install.
npx @devrik-tools/claude-gates init

# Non-interactive (for CI or scripts):
claude-gates init --project|--global  --defaults|--all|--none|--families a,b|--gates x,y  --yes  --dry-run
claude-gates init --no-install        # write the config but do not install the plugin

# Inspect the catalog:
claude-gates registry --list          # list families and gates
claude-gates registry --check         # validate registry.json

# Verify the gates actually react (not just that they are wired):
claude-gates smoke                    # feed each gate a known violation; exits non-zero if any does not block/warn
```

`smoke` is the behavioral check `registry --check` (structure) and the doctor hook (files
exist) do not do: it feeds every gate a known violation and confirms it really denies/warns.
Gates whose violation needs seeded state (a db, a git repo, cross-call state) report `skip`,
never a false pass. Run it after install, or in CI, to catch a gate that is wired but silently
allows.

---

## Repository layout

```
registry.json                     Catalog: families → gates (id, configKey, default, tools, params).
                                  The single source of truth; the menu and the hooks derive from it.
cli/                              The npm CLI (commander + @clack/prompts + zod).
  registry.mjs · selection.mjs    Load/validate the catalog; turn a selection into config.
  config.mjs · materialize.mjs    Where config lives, merge, and dump each gate's defaults.
  init.mjs · install.mjs          Interactive flow + install the plugin.
plugins/gates/                    The gates plugin.
  .claude-plugin/plugin.json
  hooks/hooks.json                One entry per gate (matcher + command). Loaded by Claude Code.
  hooks/lib/                      Shared hook code (Node built-ins only).
  hooks/gates/<id>/               One gate per folder: index.mjs (the rule) + test.mjs (its test).
plugins/tasks/                    The tasks plugin (work in progress): persists per-project tasks.
.claude-plugin/marketplace.json   Lists the marketplace plugins.
```

**Adding a gate** = one folder in `plugins/gates/hooks/gates/<id>/` (with `index.mjs` and
`test.mjs`) + one entry in `registry.json`. Everything else derives automatically.

---

## Development

```bash
npm test                  # run all tests (node --test)
npm run registry:check    # validate the catalog
npm run lint              # eslint (boundaries, no-magic-numbers, sonarjs, cspell…)
```

Each gate is tested in isolation: `node --test plugins/gates/hooks/gates/<id>/test.mjs`.

> This repo ships its own `.ai/config.json` that locally disables the gates that would
> false-positive when **editing the gates themselves** (e.g. `audit-before-build` thinks
> you are "building a tool" when you are really editing an existing gate). It is versioned
> so the repo behaves the same on any machine.

## Requirements

Node **≥ 22.5** (the `forge-flow` gate uses `node:sqlite`, available from that version).

## License

MIT.
