---
kind: check
slug: no-lint-suppressions
title: No eslint-disable added to work around a rule
created: 2026-09-06
status: passed
source: GATES.md, migrated to the artifact standard
---

# No eslint-disable added to work around a rule

## Check

Scan the changed files for `eslint-disable`, then inspect every hit by hand — a naive
substring scan cannot tell a suppression from a mention of one.

```
git diff --name-only | xargs -r grep -n "eslint-disable"
```

## Expect

No hit that is an actual `// eslint-disable` comment added to silence a rule.

## Evidence

The naive scan reported `.ai/config.json`, `README.md`, `eslint.config.mjs`. Inspected each:
`.ai/config.json` only MENTIONS the string inside a `_comment` explaining why a gate is off
during dev; `README.md` documents the `no-lint-suppression` gate in prose;
`eslint.config.mjs` sets the rule `'unicorn/no-abusive-eslint-disable': 'error'` (a rule
name, not a suppression). None is a real suppression — CLEAN by inspection.
