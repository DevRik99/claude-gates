---
kind: audit
slug: task-system-reuse
title: Reuse audit: task system
created: 2026-09-06
status: closed
source: .ai/tasks/.audit-reuse.md, migrated to the artifact standard
---

# Reuse audit: task system

## Searched

WebSearch + WebFetch (not memory alone) over Claude Code's native features, the plugin
marketplaces, and zero-dependency JSON store libraries.

## Exists

- Claude Code has NATIVE task management (updated 2026-01-23): dependencies, blocking,
  multi-session, tasks in `~/.claude/tasks/`. Cross-session preservation is solved.
- `victor-software-house/task-tracker-plugin` (MIT): preserves context across compactions,
  SessionStart/PreCompact/Stop hooks, checkpoints.
- `tintinweb/pi-tasks`: task tracking with dependencies and a widget.
- Zero-dep JSON store libs: qqdb, json-file-crud — but each brings its own contract, not
  an active/history shape.

## Missing

- AUTOMATIC classification of chat messages as task / not-task. task-tracker explicitly
  does not do this ("No automatic task detection from conversation content").
- Distinguishing a new task from one that folds into an existing one.
- A message counter driving a periodic reminder of what is still open.
- The hook into the `unlazy` skill for breaking down substantial tasks.
- A flaggable, configurable contract integrated with the claude-gates registry and CLI.

## Decision

Write `task-store.mjs` (light, no runtime deps, a specific active/history shape) plus the
uniquely valuable layer above it (distil + remind + unlazy + config). Do NOT reinvent
generic persistence or cross-compaction preservation — those are known, solved patterns.
The value is in the judgment layer, not the CRUD.
