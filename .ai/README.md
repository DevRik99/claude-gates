# The artifact standard

Everything an agent produces here that is **not source code** is an *artifact*, and every
artifact has exactly one shape and one home. Before this file, each kind existed once, in
its own ad-hoc format, in its own ad-hoc place — a checklist at the repo root, an audit
hidden inside the task store, a note buried under a feature directory. Nothing could be
found by convention and nothing could be checked.

The contract lives in code, not here: [`cli/artifacts.mjs`](../cli/artifacts.mjs) is the
single source of truth. This file explains it; the generator emits from it and the tests
validate against it, so all three cannot disagree.

## Never hand-write one

```bash
claude-gates new <kind> <slug> --title "..." --source "what asked for this"
```

It writes the file at the right path with valid front matter and every required section
already stubbed. `claude-gates new --help` lists the kinds.

## The kinds

| Kind    | Lives in       | Use it when                                                                                             |
| ------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `check` | `.ai/checks/`  | You wrote a **deterministic script/command** so we can see whether something works. One claim per file. |
| `audit` | `.ai/audits/`  | You **looked before building**. Records what was searched, what exists, what is missing, what was decided. |
| `note`  | `.ai/notes/`   | The reasoning behind work would otherwise live only in a chat log.                                       |

Plus one record that is data, not a document:

| Record       | Lives in                | Use it when                                                                     |
| ------------ | ----------------------- | --------------------------------------------------------------------------------- |
| `recurrence` | `.ai/reincidencias.json` | **The same thing went wrong twice.** Register the defect *class* and the deterministic block that closes it. |

`recurrence-lock` reads that file directly and denies mutating work while a class is open
at or above its threshold — so the entry is not paperwork, it is what forces the class to
be fixed at the root instead of patched a third time.

## Front matter (identical for every kind)

```yaml
---
kind: check | audit | note
slug: kebab-case, and it must match the file name
title: one line, what this artifact is about
created: YYYY-MM-DD
status: open | passed | failed | closed
source: what asked for this artifact
---
```

`source` is required on purpose: an artifact whose origin nobody can reconstruct is
noise. A generated artifact always starts `open` — the generator never pre-claims a result.

## Required sections

Different per kind, because what makes each trustworthy differs:

- **check** — `## Check` (the exact command), `## Expect` (what it must print or exit
  with), `## Evidence` (what it **actually** printed). Never fill Evidence in before
  running the command; a test fails a check marked `passed` whose Evidence is still the
  generated placeholder.
- **audit** — `## Searched`, `## Exists`, `## Missing`, `## Decision`.
- **note** — `## Context`, `## Change`, `## Outcome`.

## What enforces this

| Enforcer                                     | Catches                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `cli/__tests__/artifacts.test.mjs`           | The module itself: paths, rendering, every rejection case.                |
| `cli/__tests__/artifact-conformance.test.mjs` | The **real tree**: drifted front matter, wrong directory, missing sections, a `passed` check with placeholder evidence, loose markdown under `.ai/`, an invalid recurrence registry. |

The conformance test reads this repo's own `.ai/`, not fixtures — a standard the project
itself does not obey is not a standard.

## Why these are committed

`.ai/checks`, `.ai/audits` and `.ai/notes` are tracked, unlike the runtime state around
them (`tool-map.json`, `capability-map.json`, `gates-log.jsonl`, `tasks/`). An audit
exists so the same search is not repeated; evidence exists so a claim can be re-checked.
Both are worthless if they vanish with the working directory.
