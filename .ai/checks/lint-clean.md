---
kind: check
slug: lint-clean
title: npm run lint exits 0
created: 2026-09-06
status: passed
source: GATES.md, migrated to the artifact standard
---

# npm run lint exits 0

## Check

```
npm run lint
```

## Expect

Exit code 0.

## Evidence

Ran the eslint task with no output and exit code 0, verified explicitly with
`echo "EXIT CODE: $?"` -> `EXIT CODE: 0`.
