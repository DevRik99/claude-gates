---
kind: note
slug: quality-gates-migration
title: Migration of 10 quality guards to plugins/gates
created: 2026-09-06
status: closed
source: .ai/features/quality-gates-migration/tasks/main/impl.md, migrated
---

# Migration of 10 quality guards to plugins/gates

## Context

Ten quality guards lived in `~/.claude/hooks/guard-*.mjs` in a standalone format, outside
the registry, the config layer and the test suite.

## Change

Ported to the `runGate` format under `plugins/gates/hooks/gates/*`, rewritten in English
and with improved logic — not translated line by line. Per-gate detail follows.
Portados desde `~/.claude/hooks/guard-*.mjs` (formato standalone) al formato `runGate`
de `plugins/gates/hooks/gates/*.mjs`, reescritos en inglés y con lógica mejorada, no
traducidos línea por línea.

## Por gate

1. **dependency-skills.mjs** (`requireSkillForNewDependency`, WARN). En Write/Edit a
   `package.json`, junta dependencies+devDependencies, exceptúa `depsWithoutOwnApi`
   (+ prefijo `@types/`), lista skills en `projectSkillsDir` y compara por substring
   normalizado. Simplificación deliberada: se dropeó la tabla de alias hardcodeados
   (stripe->stripe-payments) y el mecanismo `.ai/skills-baseline.json` de congelamiento
   de deuda — pertenecen a `adopt-stack-and-skills.mjs`, que no existe en este repo.

2. **root-cause-first.mjs** (`requireRootCauseBeforePatch`, DENY, default off). Detecta
   el marcador de parche `// TODO fix later patch` en Write/Edit o en el prompt de una
   delegación. Simplificación: el guard fuente usaba un módulo auxiliar
   (`lib/embedded-content-detection.mjs`) para distinguir código real de una cita en
   markdown; ese módulo no existe acá, así que se matchea directo sobre el contenido.

3. **audit-before-build.mjs** (`requireAuditBeforeBuilding`, DENY, default off). Dos
   ramas: delegación que pide crear una herramienta nueva sin evidencia textual de
   auditoría previa, y Write de un archivo ejecutable en `toolFolders` sin comentario de
   justificación. Patrones reescritos en inglés (already exists, no existing tool, no
   plugin, audited and, justification:) manteniendo equivalentes en español.

4. **never-assume.mjs** (`requireVerificationBeforeAssuming`, WARN, default off). Busca
   frases de conjetura ("i assume", "probably", "should be"...) en Write/Edit/delegación.
   Nunca deniega — igual que el guard fuente, que es explícito: aviso, no bloqueo.

5. **rule-skill-autodiscovery.mjs** (`autodiscoverRulesAndSkills`, DENY, default off).
   Descubre scripts `.mjs`/`.js` en `<cwd>/<rulesDir>` y en `.claude/skills/*/{gate,
   rules,check,verify}.mjs` (o `*.gate.mjs`), los ejecuta con `execFileSync` y deniega si
   alguno falla. Usa `process.cwd()` como raíz, igual que el guard fuente (no climbing a
   `.git`).

6. **recurrence-lock.mjs** (`blockRegisteredRecurrences`, DENY, default on). El guard
   fuente depende de `../scripts/memory/recurrences.mjs`, módulo inexistente en este
   repo. Degradación: lee `.ai/reincidencias.json` si existe, con forma propia
   `{classes:[{class, occurrences:[...], status}]}`; si no existe el archivo, allow
   silencioso. Cuenta clases con `occurrences.length >= thresholdAppearances` y
   `status !== 'closed'/'cerrada'`.

7. **test-after-implementation.mjs** (`warnTestWrittenAfterImplementation`, WARN, default
   off). En Write de un archivo `.test.`/`.spec.` que no existe todavía, si
   `git status --porcelain` muestra el archivo de implementación pareado (mismo nombre
   base, extensión de `implementationExtensions`, mismo directorio relativo al repo)
   como modificado/creado sin commitear, avisa. El guard fuente deniega; acá se avisa
   porque el propio configKey (`warnTestWrittenAfterImplementation`) declara warn como
   severidad esperada — discrepancia documentada en el código. Degrada a allow sin git.
   Bug encontrado y corregido durante el desarrollo: comparar el directorio del test por
   ruta absoluta contra las rutas relativas que devuelve `git status --porcelain` nunca
   matcheaba (`dirname()` de ruta absoluta vs. ruta relativa); se normalizó comparando
   ambos directorios relativos al repo, con `'.'` como raíz.

8. **no-reconfirm.mjs** (`requireNoReconfirmOfApproved`, WARN, default on). Lee
   `transcript_path` del payload, filtra turnos humanos reales, y en dos etapas (patrón
   de aprobación explícita + solapamiento de palabras significativas >= umbral) avisa si
   una `AskUserQuestion` repite el tema de algo ya aprobado. Patrones y stopwords
   reescritos en inglés.

9. **neutral-spanish.mjs** (`warnNonNeutralSpanish`, WARN, default on). Lista de
   marcadores rioplatenses idéntica al guard fuente (voseo + léxico), como strings de
   datos en un array — nunca agregados a un diccionario cSpell. Mejora sobre el
   original: el borde de palabra usa `\p{L}` (cualquier letra Unicode) en vez de una
   clase de caracteres acentuados escrita a mano, evitando literales acentuados en el
   código fuente que el linter marcaría como palabra desconocida.

10. **diagnosis-before-patch.mjs** (`warnTimeoutChangeWithoutDiagnosis`, WARN, default
    on). Detecta asignación numérica a claves TIMEOUT/DEADLINE/IDLE/retry/backoff y
    avisa pedir confirmación de que se leyó evidencia (log) antes de tocar el valor.

## Degradaciones (todas testeadas explícitamente)

- `recurrence-lock.mjs`: sin `.ai/reincidencias.json` → allow.
- `rule-skill-autodiscovery.mjs`: sin `rules/` ni `.claude/skills/` → allow.
- `test-after-implementation.mjs`: sin git / no es repo → allow.
- `no-reconfirm.mjs`: sin `transcript_path` legible → allow.

## Verificación final

- `node --test "plugins/gates/hooks/gates/__tests__/*.test.mjs"`: **144 pass, 0 fail**
  (50 tests nuevos de los 10 gates + 94 preexistentes, incluidos
  bash-commands/protected-paths/root-whitelist).
- `npx eslint` sobre los 10 gates + 10 tests nuevos: **limpio, 0 errores, 0 warnings**.

## OUT_OF_SCOPE

- `npx eslint plugins/gates/hooks/gates/` (carpeta completa) reporta 7 errores y 4
  warnings preexistentes en archivos fuera de este scope: `circuit-breaker.mjs`
  (hard-coded path, 3x super-linear-regex, regex-complexity, complexity warning),
  `intent-flow.mjs` (complexity warning), `no-memory-dependency.mjs` (regex-complexity,
  1 prettier fixable), `reuse-before-build.mjs` (complexity warning), `tool-map.mjs`
  (complexity warning). Ninguno se tocó; están fuera del alcance declarado (QUE NO:
  no tocar nada más que los 10 gates de esta tarea).

## Outcome

All ten run under the shared scaffolding, are declared in the registry, and are covered by
the consistency and smoke checks. Deliberate simplifications (dropped alias tables, the
`.ai/skills-baseline.json` debt-freezing mechanism, the embedded-content-detection helper)
are recorded per gate above: each belongs to a module that does not exist in this repo.
