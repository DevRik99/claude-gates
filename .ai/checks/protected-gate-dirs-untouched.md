---
kind: check
slug: protected-gate-dirs-untouched
title: The three protected gate directories are untouched
created: 2026-09-06
status: passed
source: GATES.md, migrated to the artifact standard
---

# The three protected gate directories are untouched

## Check

```
git diff --name-only -- plugins/gates/hooks/gates/no-coauthor   plugins/gates/hooks/gates/no-lint-suppression   plugins/gates/hooks/gates/capability-map
```

## Expect

Empty output.

## Evidence

The command produced no output.

Superseded on 2026-09-06: `capability-map` was deliberately reopened, with the user's
explicit approval, to add work-nature re-injection. This check applied to the lint task
that created it, not to later work.
