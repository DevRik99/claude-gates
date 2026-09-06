# claude-gates

**Barreras (gates) instalables y deterministas para Claude Code.** Se ejecutan
automáticamente antes de que Claude use una herramienta y **bloquean o avisan** cuando algo
viola una regla: un comando destructivo, una escritura a un archivo protegido, una
delegación sin brief, y más. Todo es **configurable por proyecto** y **se puede
prender/apagar** cuando quieras.

La idea de fondo: en vez de confiar en que el modelo *recuerde* las reglas, un hook
**determinista** las hace cumplir. Un `git reset --hard` no se ejecuta porque el modelo
haya decidido portarse bien; se bloquea porque un gate lo intercepta.

🇬🇧 [Read it in English](./README.md)

---

## Instalación

Dos pasos. El **plugin** engancha los hooks en Claude Code; el **CLI** elige qué gates se
ejecutan y con qué configuración.

```bash
# 1. Registrar el marketplace e instalar el plugin (engancha los hooks)
claude plugin marketplace add https://github.com/DevRik99/claude-gates
claude plugin install gates@claude-gates

# 2. Elegir qué gates adoptar (menú interactivo) — o usar npx sin clonar
npx @devrik-tools/claude-gates init
```

Reinicia la sesión de Claude Code (o ejecuta `/plugin`) para que los hooks carguen.

> **¿Por qué dos cosas?** El plugin **siempre trae los 50 gates**; la configuración decide
> **cuáles se ejecutan**. Así puedes prender uno sin reinstalar: es una línea en un JSON.

---

## Cómo funciona (el modelo en 30 segundos)

```
Claude va a usar una herramienta (Write, Bash, Agent…)
        │
        ▼
Claude Code dispara los hooks PreToolUse en paralelo
        │
        ▼
Cada gate que aplica (según su "matcher") se ejecuta en su propio proceso:
   · lee el payload          · lee su configuración del proyecto
   · si está apagado → sale  · si la regla se viola → DENY (bloquea) o WARN (avisa)
        │
        ▼
Si algún gate bloquea, la herramienta no se ejecuta.
```

- **DENY**: la acción es determinísticamente incorrecta → se bloquea.
- **WARN**: la acción necesita criterio → el gate inyecta un aviso y deja seguir.
- **Silencio**: el caso común. Un gate no molesta si no hay nada que objetar.

Todo mensaje DENY/WARN lleva el prefijo `[configKey]` — el nombre exacto de la clave para
buscar (o apagar/ajustar) bajo `"gates"` en `.ai/config.json`, por ejemplo
`[blockPathsOutsideRootWhitelist] '...' no está en la whitelist.` significa que la
configuración es `blockPathsOutsideRootWhitelist` en la tabla de abajo, no otro nombre que
haya que adivinar o traducir desde un id corto de gate.

Cada gate es **autocontenido** (solo Node built-ins, sin dependencias en tiempo de
ejecución), así que funciona aunque instales uno suelto por fuera.

---

## Los gates (50, en 11 familias)

`[on]` = encendidos por defecto; `[off]` = los prendes si los quieres.

### 🔒 Security — bloqueos duros sobre lo destructivo
| Gate | | Qué hace |
|---|---|---|
| `bash-commands` | on | Bloquea `git reset --hard`, `rm -rf` sobre áreas protegidas, force push, y matar procesos por nombre. |
| `block-remote-publish` | on | Bloquea `git push`, `gh pr merge`, `gh release create` sin autorización. Poné `blockRemotePublish: false` para permitir que el agente publique por su cuenta. |
| `protected-paths` | on | Bloquea escrituras a `.env`, lockfiles y el propio harness. |
| `root-whitelist` | on | Bloquea crear archivos/carpetas nuevos en la raíz fuera de la lista blanca. |
| `no-blocking` | off | Bloquea `sleep`, `tail -f`, bucles de sondeo y servidores en primer plano. |
| `require-monitor` | on | Bloquea un comando en background (`run_in_background: true`) que no declara su monitor con el marcador `MONITOR-PLANNED:`, y bloquea cualquier ejecución posterior mientras quede un background sin monitorear. |

### 🤝 Delegation — exigencias sobre el brief al delegar a un subagente
| Gate | | Qué hace |
|---|---|---|
| `brief-before-delegate` | off | Exige objetivo, pasos y criterio de "listo" en el prompt. |
| `intent-flow` | off | Exige secciones QUÉ SÍ / QUÉ NO / EDGE CASES. |
| `risk-level` | off | Exige declarar el nivel (QUESTION/MICRO/STANDARD/HIGH-RISK). |
| `circuit-breaker` | off | Corta la misma delegación reintentada sin cambios reales. |
| `no-memory-dependency` | off | Bloquea un brief que depende de que el subagente "recuerde" la conversación (marcador `memory-not-needed` para un falso positivo). |
| `force-parallel` | on | Bloquea la enésima delegación secuencial consecutiva dentro de una ventana de tiempo: las delegaciones independientes se lanzan juntas en un solo mensaje (marcador `SEQUENTIAL-JUSTIFIED` cuando la segunda depende de verdad de la primera). |

### 📋 Spec-driven flow — solo aplican si el proyecto adoptó desarrollo por specs
| Gate | | Qué hace |
|---|---|---|
| `feature-catalog` | on | Una sola feature en progreso; cerrar exige asserts y revisión. |
| `sdd-specs` | off | Exige requirements/design/tasks no vacíos antes de implementar. |
| `brief-approved` | on | Exige una aprobación del usuario registrada (`status: approved` + cita) en el brief de la feature citada antes de implementar. |
| `implementation-pipeline` | off | Exige declarar definición → escritura → validación → QA → cierre. |
| `mandatory-flow` | off | Exige una tarea activa con contrato antes de implementar. |
| `test-matrix` | off | Exige una matriz de tests (los tipos que el requerimiento vuelve obligatorios). |

### ✨ Quality — higiene de código, diagnóstico y lenguaje
| Gate | | Qué hace |
|---|---|---|
| `dependency-skills` | on | Bloquea una dependencia directa nueva sin skill que la cubra (declarala en `depsWithoutOwnApi` si no necesita). |
| `root-cause-first` | off | Exige un diagnóstico origen→síntoma antes de un parche. |
| `audit-before-build` | off | Antes de un script/gate nuevo, exige declarar que nada existente lo cubre. |
| `never-assume` | off | Marca suposiciones sin verificar en briefs y código. |
| `rule-skill-autodiscovery` | off | Carga los gates que el proyecto declara en sus `rules/` y `skills/`. |
| `recurrence-lock` | on | La segunda aparición de un defecto exige su bloqueo determinista. |
| `test-after-implementation` | off | Bloquea un test escrito después de su implementación pareja (marcador `test-after-impl:allow` para un test de regresión). |
| `no-reconfirm` | on | Nunca vuelve a preguntar lo que ya respondiste. |
| `neutral-spanish` | on | Bloquea voseo o léxico regional en el texto escrito (marcador `neutral-spanish:allow` para una cita/fixture deliberada). |
| `diagnosis-before-patch` | on | Avisa cuando se cambian timeouts/reintentos sin evidencia. |
| `lint-commit` | off | Bloquea `git commit` mientras el script de lint del proyecto falla (autodetecta `npm run lint`; silencioso si no hay). |
| `staged-lint` | off | Bloquea `git commit` cuando los archivos **en el stage** fallan lint — lintea solo lo que agregaste al stage, así tu cambio no puede meter deuda de lint nueva y la deuda preexistente en archivos que no tocaste nunca te bloquea. Marcador `[skip-lint]` para una excepción deliberada. |
| `atomic-commit` | off | Bloquea un `git commit` que no es atómico — que mezcla más de N naturalezas de cambio (código/tests/deps/config…) o stagea más archivos revisables de los que un commit debería llevar. Docs/imágenes/generados no cuentan. Marcador `[wip]` para un commit deliberadamente amplio. |
| `no-coauthor` | on | Bloquea un `git commit` que lleve un trailer de atribución de IA (`Co-Authored-By`, `Generated with`, un trailer de sesión). Marcador `[allow-coauthor]` para un co-autor legítimo. |
| `no-lint-suppression` | on | Bloquea una escritura que silencia el linter/type-checker (`eslint-disable`, `@ts-ignore`, una regla en `off`) en vez de arreglar el código. Marcador `lint-ok: <razón>` en la misma línea para un falso positivo documentado. |
| `no-explanatory-comments`   | on  | Bloquea una escritura de código que agrega comentarios que narran qué hace el código. Solo pasan comentarios de decisión (el porqué, un trade-off, una limitación), directivas de herramientas, `TODO`/`FIXME` y etiquetas JSDoc con tipo. Juzga solo comentarios nuevos (diff contra disco). `comment-ok: <razón>` para una excepción documentada. |
| `no-trivial-scripts` | on | Bloquea un script inline de intérprete que hace una operación de archivos que las herramientas `Edit`/`Write` resuelven directo (`node -e` con `writeFileSync`, `python -c` con `open(…, 'w')`, `sed -i`, `perl -i`, `Set-Content`/`Add-Content`). Los scripts inline que solo computan no caen. |

### 🔎 Tool discovery — no reinventar la rueda
| Gate | | Qué hace |
|---|---|---|
| `reuse-before-build` | off | Antes de construir una herramienta, consulta el mapa de herramientas del proyecto; bloquea si no auditaste (local → Context7 → web). |
| `tool-map` | off | Registra las herramientas descubiertas en `.ai/tool-map.json` para no volver a explorar. |
| `skill-first` | off | Bloquea una escritura/comando/delegación que una **skill** disponible cubre de forma plausible hasta que la pregunta se haya hecho: cargar la skill, o decir por qué no aplica (`no skill covers this` / `using the <name> skill`). Lee el mismo catálogo que inyecta `capability-map`. |

### 🧠 Research flow — la memoria primero, nunca adivinar una librería

| Gate           |     | Qué hace                                                                                                                                                                                                                                                                                              |
| -------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engram-first` | on  | Bloquea `WebSearch`, `WebFetch` y context7 hasta que en la sesión haya corrido un `mem_search` ([engram](https://github.com/Gentleman-Programming/engram) es la primera fuente); bloquea el Stop mientras hubo investigación sin un `mem_save` posterior; al arrancar avisa una vez si engram cloud está configurado y el proyecto no está enrolado. |
| `library-docs` | on  | Bloquea una escritura que importa un paquete que el proyecto no usa en ningún lado, salvo que en esta sesión se haya consultado: un hit de engram sobre él, o docs de context7 seguidas de un `mem_save`. Nunca adivinar la API de una librería.                                                       |

### 🏭 Forge pipeline — obliga a seguir el flujo de forge
| Gate | | Qué hace |
|---|---|---|
| `forge-flow` | off | En un proyecto que adoptó [forge](https://github.com/DevRik99/forge-mcp), bloquea editar/ejecutar si no hay un run de forge activo. Cierra el hueco que el MCP no puede: te obliga a pasar por el pipeline. |

### 🤖 Autonomy — que una corrida sin supervisión decida en vez de preguntar

| Gate | | Qué hace |
|---|---|---|
| `autonomous-mode` | off | Con el modo autónomo prendido, bloquea `AskUserQuestion` y bloquea que el turno termine solo para esperar: reinyecta, una vez por ciclo, la instrucción de decidir y seguir, dejando pendiente solo lo que de verdad necesita al usuario. |

### ⏹️ Completion — el turno no termina con trabajo abierto

| Gate | | Qué hace |
|---|---|---|
| `stop-pending` | on | Bloquea el evento Stop mientras el proyecto tiene tareas activas (`open`/`in_forge`); las lista y explica cómo cerrarlas con evidencia verificada o abandonarlas. Las tareas `blocked` no retienen el turno por defecto. |
| `require-task-split` | on | Bloquea escrituras y ejecución mientras una tarea activa más grande que `small` no tenga sub-tareas registradas: primero se parte en piezas verificables por separado (`task add --parent <id>`). |

### 🗂️ Task tracking — el plugin de tareas

| Gate | | Qué hace |
|---|---|---|
| `remind-open-tasks` | on | Hace que el asistente clasifique y registre el trabajo nuevo por el CLI, y recita las tareas activas cada N mensajes. |
| `list-tasks-on-session-start` | on | Lista las tareas activas del proyecto al abrir una sesión. Silencioso si no hay ninguna. |

### 🩺 Sesión y contexto — validaciones al arrancar e inyección de capacidades
| Gate | | Qué hace |
|---|---|---|
| `doctor` | on | Al iniciar la sesión, corre el validador de entorno y solo habla si algo falla. |
| `ask-adoption` | on | En un proyecto que nunca respondió, hace que el asistente pregunte qué adoptar. |
| `wiring-check` | on | Avisa cuando un hook registrado falta o un script quedó huérfano. |
| `capability-map` | on | Cada `injectEveryMessages` mensajes (default 10; siempre en la primera corrida y cuando se agrega/borra una capacidad), inyecta el catálogo de capacidades del proyecto — skills, agents/subagents, comandos — como dato compacto, y lo persiste en `.ai/capability-map.json` (como el mapa de herramientas). Autosincronizado desde el disco. Nunca bloquea. |

---

## Configuración: prender, apagar y ajustar cada gate

Todo vive en un solo archivo. **El proyecto manda sobre el global:**

- **Proyecto:** `<raíz>/.ai/config.json`
- **Global (fallback):** `~/.claude/claude-gates/config.json`

`init` escribe ahí la selección **y materializa los valores por defecto de cada gate**, así
ves y editas cada perilla:

```json
{
  "adopted": "partial",
  "gateVersion": "3.1.0",
  "gates": {
    "blockDestructiveShellCommands": {
      "enabled": true,
      "rmRfProtectedAreas": ["/", "*", "src", "tests"],
      "denyPatterns": ["git reset --hard", "…"]
    },
    "requireBriefBeforeDelegating": { "enabled": false }
  }
}
```

- **Apagar un gate:** `"enabled": false`. Se apaga al instante, sin reinstalar. O desde el CLI:
  `claude-gates disable <gate>` / `claude-gates enable <gate>` (ids de gate, claves de
  configuración, ids de familia o `all`; `--project` o `--global`), y `claude-gates status`
  para ver qué está prendido en el directorio actual y de dónde sale cada valor.
- **Volver a correr `init` mergea, nunca pisa.** Un gate que ya está en el archivo solo cambia
  si lo nombras (`--gates`, `--families`, `--all`, `--none`) y, cuando su `enabled` cambiaría,
  lo confirmas gate por gate. Con `--yes` (sin TTY) se conservan los valores existentes y se
  reportan; con `--force` se aplican sin preguntar.
- **Un parámetro con el tipo equivocado nunca rompe un gate.** Un string donde se espera una
  lista, o un regex mal escrito, cae al default incorporado y se reporta una vez por sesión
  en el propio mensaje del gate (y en el log de decisiones).
- **Ajustar su comportamiento:** editas sus parámetros (la lista blanca, los patrones, los
  umbrales). Lo que declara el proyecto **reemplaza** el default del gate.
- Un gate que no aparece en la configuración usa su default del catálogo. Las claves que ya
  tuvieras en el archivo (por ejemplo `autoCommit`) se conservan intactas.
- **Válvulas de escape:** algunos gates bloquean (deny) pero aceptan un marcador explícito
  de exención en el contenido/prompt para un caso legítimo: `neutral-spanish:allow` (una cita
  regional deliberada), `test-after-impl:allow` (un test de regresión), `memory-not-needed`
  (una frase que no depende de memoria), `[allow-coauthor]` (un co-autor legítimo en un
  commit), `lint-ok: <razón>` (un falso positivo documentado del linter), `[skip-lint]`
  (saltea el chequeo de staged-lint por un commit), `[wip]` (permite un commit
  deliberadamente amplio, no atómico), `comment-ok: <razón>` (un comentario explicativo que
  debe quedarse), `SEQUENTIAL-JUSTIFIED` (una delegación que sí depende de la anterior),
  `MONITOR-PLANNED:` (el comando en background declara cómo se va a monitorear).
  `dependency-skills` se exime vía su lista `depsWithoutOwnApi`. `skill-first` se despeja
  con una frase en el contenido/prompt: `no skill covers this`, o `using the <name> skill`.
- **Inyección de capacidades:** `capability-map` (on por defecto) es totalmente ajustable —
  elegí qué tipos exponer (`"kinds": ["skills", "agents", "commands"]`), limitá cada blurb
  (`maxClauseChars`, default 120), agregá raíces extra por tipo, regulá cada cuánto se
  re-inyecta el catálogo completo (`injectEveryMessages`, default 10 — el archivo persistido
  se refresca igual en cada mensaje; el catálogo TAMBIÉN se re-inyecta a mitad del throttle
  cuando cambia el tipo de trabajo del prompt, por ejemplo depurar → publicar, lo que podés
  apagar con `"reinjectOnWorkNatureChange": false`), o apagá la persistencia (`"persist": false`) y apuntá
  el mapa a otro archivo (`mapFile`). Las skills también se escanean por defecto en
  `~/.agents/skills`, `<proyecto>/.agents/skills`, `~/.ai/skills` y `<proyecto>/.ai/skills`
  (raíces exclusivas de skills que usan otros instaladores además de `.claude/skills` — sin
  necesidad de configurar nada), sumadas a cualquier `extraSkillsDirs` que el proyecto
  declare. Una descripción que no entra en `maxClauseChars` cae al truncado mecánico por
  palabra completa, pero podés escribir a mano un resumen mejor por capacidad en
  `~/.claude/blurb-overrides.json` (global) o `<proyecto>/<blurbOverridesFile>` (default
  `.ai/blurb-overrides.json`, el proyecto gana por clave) — un mapa
  `{ "nombre-skill": "resumen corto" }`, usado tal cual en vez del corte mecánico. El
  re-escaneo de una capacidad se saltea (se reusa su blurb tal cual) cuando el disco no
  cambió desde el último escaneo (mismos archivos fuente, mismos mtimes); borrar una
  skill/agente/comando saca su entrada del mapa en la corrida siguiente.

---

## Log de decisiones

Cada deny, warn y bloqueo de Stop se agrega como una línea JSON a
`<raíz>/.ai/gates-log.jsonl` (fecha, gate, clave de configuración, herramienta, un resumen de
una línea de la acción, el motivo, la sesión). Se lee con:

```bash
claude-gates log                      # últimas 30 decisiones de este proyecto
claude-gates log --deny --gate bash-commands --tail 100
claude-gates log --since 2026-09-01T00:00:00Z --json
```

El archivo rota una vez a los 5 MB (`gates-log.1.jsonl`). `CLAUDE_GATES_LOG=0` lo desactiva.

---

## Tareas: se registran con criterio y se cierran con evidencia verificada

Una tarea lleva su criterio de verificación **desde que se crea** — `task add` rechaza una
tarea que nadie puede probar terminada — y `task close` rechaza texto libre: está hecha solo
cuando la verificación pasa de verdad.

```bash
# Registrar: el criterio es obligatorio (--verify-command o --verify-path)
claude-gates task add "migrar el cargador de configuración" \
  --size medium --verify-command "npm test" --verify-expect "fail 0"
claude-gates task add "escribir la guía de migración" \
  --parent <id> --verify-path docs/migration.md --verify-contains "## Upgrading"

claude-gates task list [--all]        # tareas activas (o todo el historial)

# Cerrar: sin --check/--exists, se vuelve a correr el criterio propio de la tarea
claude-gates task close <id>
claude-gates task close <id> --check "npm test" --expect "fail 0" --note "suite en verde"
claude-gates task close <id> --exists dist/report.html --contains "All green"
claude-gates task abandon <id> --reason "obsoleta"
claude-gates task promote <id> <runId>   # vincula la tarea a un run de forge
```

El resultado verificado (comando, código de salida, cola de la salida, fecha) queda guardado
con la tarea. Dos gates se apoyan en este store: `require-task-split` bloquea implementar una
tarea más grande que `small` sin sub-tareas, y `stop-pending` impide que el turno termine
mientras queden tareas abiertas.

---

## Comandos del CLI

```bash
# Menú interactivo: elige plugins, familias o gates, por proyecto o global, e instala.
npx @devrik-tools/claude-gates init

# Sin menú (para CI o scripts):
claude-gates init --project|--global  --defaults|--all|--none|--families a,b|--gates x,y  --yes  --dry-run
claude-gates init --no-install        # escribe la configuración pero no instala el plugin
claude-gates init --force             # aplica cambios a gates ya presentes sin preguntar

# Prender, apagar e inspeccionar lo que corre aquí:
claude-gates enable <gate|familia|all> [--project|--global]
claude-gates disable <gate|familia|all> [--project|--global]
claude-gates status                   # on/off efectivo por gate y su origen (project/global/default)
claude-gates log [--tail N] [--deny] [--gate id] [--since iso] [--json]
claude-gates doctor                   # ¿Claude Code corre ESTA versión del paquete?

# Tareas (el store que leen los gates de completion):
claude-gates task add <título> --size <tamaño> --verify-command <cmd>|--verify-path <ruta> [--parent <id>]
claude-gates task list [--all]
claude-gates task close <id> [--check <cmd> --expect <texto>] [--exists <ruta> --contains <texto>]
claude-gates task abandon <id> --reason <texto>
claude-gates task promote <id> <runId>

# Inspeccionar el catálogo:
claude-gates registry --list          # lista familias y gates
claude-gates registry --check         # valida registry.json y que hooks.json esté sincronizado
claude-gates registry --sync-hooks    # regenera el hooks.json de cada plugin desde el registry

# Verificar que los gates realmente reaccionan (no solo que están enganchados):
claude-gates smoke                    # le da a cada gate una violación conocida; sale distinto de 0 si alguno no bloquea/avisa
```

`smoke` es el chequeo de comportamiento que `registry --check` (estructura) y el hook doctor
(que los archivos existan) no hacen: le da a cada gate una violación conocida y confirma que
de verdad deniega o avisa. Los gates cuya violación necesita estado sembrado (una db, un repo
git, estado entre llamadas) reportan `skip`, nunca un falso pase. Se corre después de
instalar, o en CI, para detectar un gate enganchado que en silencio deja pasar todo.

---

## Estructura del repositorio

```
registry.json                     Catálogo: familias → gates (id, configKey, default, tools, params).
                                  Es la única fuente de verdad; el menú y los hooks derivan de él.
cli/                              El CLI de npm (commander + @clack/prompts + zod).
  registry.mjs · selection.mjs    Cargar/validar el catálogo; convertir la selección en configuración.
  config.mjs · materialize.mjs    Dónde vive la configuración, merge, y volcar los defaults de cada gate.
  init.mjs · install.mjs          Flujo interactivo + instalar el plugin.
plugins/gates/                    El plugin de gates.
  .claude-plugin/plugin.json
  hooks/hooks.json                Generado desde registry.json (`registry --sync-hooks`). Lo carga Claude Code.
  hooks/lib/                      Código compartido de los hooks (Node built-ins only).
  hooks/gates/<id>/               Un gate por carpeta: index.mjs (la regla) + test.mjs (su test).
plugins/tasks/                    El plugin de tareas: persiste tareas por proyecto, recuerda las abiertas
                                  y las lista al arrancar la sesión.
.claude-plugin/marketplace.json   Lista los plugins del marketplace.
```

**Agregar un gate** = una carpeta en `plugins/gates/hooks/gates/<id>/` (con `index.mjs` y
`test.mjs`) + una entrada en `registry.json`, y luego `claude-gates registry --sync-hooks`.
Los gates comparten `hooks/lib/` (lectura del payload, normalización de git, estado por
sesión, vocabulario de delegación, el log de decisiones, el harness de tests): un gate es solo su regla.

---

## Desarrollo

```bash
npm test                  # ejecuta todos los tests (node --test)
npm run registry:check    # valida el catálogo
npm run lint              # eslint (boundaries, no-magic-numbers, sonarjs, cspell…)
```

Cada gate se testea aislado: `node --test plugins/gates/hooks/gates/<id>/test.mjs`
(nombra los archivos de test: un glob que también matchee `index.mjs` se cuelga, porque un gate espera stdin).

> Este repositorio trae su propio `.ai/config.json` que apaga localmente los gates que
> darían falso positivo al **editar los gates mismos** (por ejemplo, `audit-before-build`
> cree que estás "construyendo una herramienta" cuando en realidad editas un gate
> existente). Por eso está versionado: el repo se comporta igual en cualquier máquina.

## Requisitos

Node **≥ 22.5** (el gate `forge-flow` usa `node:sqlite`, disponible desde esa versión).

## Licencia

MIT.
