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

> **¿Por qué dos cosas?** El plugin **siempre trae los 40 gates**; la configuración decide
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

Cada gate es **autocontenido** (solo Node built-ins, sin dependencias en tiempo de
ejecución), así que funciona aunque instales uno suelto por fuera.

---

## Los gates (30, en 7 familias)

`[on]` = encendidos por defecto; `[off]` = los prendes si los quieres.

### 🔒 Security — bloqueos duros sobre lo destructivo
| Gate | | Qué hace |
|---|---|---|
| `bash-commands` | on | Bloquea `git reset --hard`, `rm -rf` sobre áreas protegidas, force push, y matar procesos por nombre. |
| `block-remote-publish` | on | Bloquea `git push`, `gh pr merge`, `gh release create` sin autorización. Poné `blockRemotePublish: false` para permitir que el agente publique por su cuenta. |
| `protected-paths` | on | Bloquea escrituras a `.env`, lockfiles y el propio harness. |
| `root-whitelist` | on | Bloquea crear archivos/carpetas nuevos en la raíz fuera de la lista blanca. |
| `no-blocking` | off | Bloquea `sleep`, `tail -f`, bucles de sondeo y servidores en primer plano. |

### 🤝 Delegation — exigencias sobre el brief al delegar a un subagente
| Gate | | Qué hace |
|---|---|---|
| `brief-before-delegate` | off | Exige objetivo, pasos y criterio de "listo" en el prompt. |
| `intent-flow` | off | Exige secciones QUÉ SÍ / QUÉ NO / EDGE CASES. |
| `risk-level` | off | Exige declarar el nivel (QUESTION/MICRO/STANDARD/HIGH-RISK). |
| `circuit-breaker` | off | Corta la misma delegación reintentada sin cambios reales. |
| `no-memory-dependency` | off | Bloquea un brief que depende de que el subagente "recuerde" la conversación (marcador `memory-not-needed` para un falso positivo). |

### 📋 Spec-driven flow — solo aplican si el proyecto adoptó desarrollo por specs
| Gate | | Qué hace |
|---|---|---|
| `feature-catalog` | on | Una sola feature en progreso; cerrar exige asserts y revisión. |
| `sdd-specs` | off | Exige requirements/design/tasks no vacíos antes de implementar. |
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

### 🔎 Tool discovery — no reinventar la rueda
| Gate | | Qué hace |
|---|---|---|
| `reuse-before-build` | off | Antes de construir una herramienta, consulta el mapa de herramientas del proyecto; bloquea si no auditaste (local → Context7 → web). |
| `tool-map` | off | Registra las herramientas descubiertas en `.ai/tool-map.json` para no volver a explorar. |

### 🏭 Forge pipeline — obliga a seguir el flujo de forge
| Gate | | Qué hace |
|---|---|---|
| `forge-flow` | off | En un proyecto que adoptó [forge](https://github.com/DevRik99/forge-mcp), bloquea editar/ejecutar si no hay un run de forge activo. Cierra el hueco que el MCP no puede: te obliga a pasar por el pipeline. |

### 🩺 Sesión y contexto — validaciones al arrancar e inyección de capacidades
| Gate | | Qué hace |
|---|---|---|
| `doctor` | on | Al iniciar la sesión, corre el validador de entorno y solo habla si algo falla. |
| `ask-adoption` | on | En un proyecto que nunca respondió, hace que el asistente pregunte qué adoptar. |
| `wiring-check` | on | Avisa cuando un hook registrado falta o un script quedó huérfano. |
| `capability-map` | off | En cada mensaje, inyecta el catálogo de capacidades del proyecto — skills, agents/subagents, comandos — como dato compacto, y lo persiste en `.ai/capability-map.json` (como el mapa de herramientas). Autosincronizado desde el disco. Nunca bloquea. |

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
  "gateVersion": "3.0.0",
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

- **Apagar un gate:** `"enabled": false`. Se apaga al instante, sin reinstalar.
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
  deliberadamente amplio, no atómico). `dependency-skills` se exime vía su lista
  `depsWithoutOwnApi`.
- **Inyección de capacidades:** `capability-map` (off por defecto) es totalmente ajustable —
  elegí qué tipos exponer (`"kinds": ["skills", "agents", "commands"]`), limitá cada blurb
  (`maxClauseChars`), agregá raíces extra por tipo, o apagá la persistencia
  (`"persist": false`) y apuntá el mapa a otro archivo (`mapFile`).

---

## Comandos del CLI

```bash
# Menú interactivo: elige plugins, familias o gates, por proyecto o global, e instala.
npx @devrik-tools/claude-gates init

# Sin menú (para CI o scripts):
claude-gates init --project|--global  --defaults|--all|--none|--families a,b|--gates x,y  --yes  --dry-run
claude-gates init --no-install        # escribe la configuración pero no instala el plugin

# Inspeccionar el catálogo:
claude-gates registry --list          # lista familias y gates
claude-gates registry --check         # valida registry.json
```

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
  hooks/hooks.json                Una entrada por gate (matcher + comando). Lo carga Claude Code.
  hooks/lib/                      Código compartido de los hooks (Node built-ins only).
  hooks/gates/<id>/               Un gate por carpeta: index.mjs (la regla) + test.mjs (su test).
plugins/tasks/                    El plugin de tareas (en construcción): persiste tareas por proyecto.
.claude-plugin/marketplace.json   Lista los plugins del marketplace.
```

**Agregar un gate** = una carpeta en `plugins/gates/hooks/gates/<id>/` (con `index.mjs` y
`test.mjs`) + una entrada en `registry.json`. El resto se deriva solo.

---

## Desarrollo

```bash
npm test                  # ejecuta todos los tests (node --test)
npm run registry:check    # valida el catálogo
npm run lint              # eslint (boundaries, no-magic-numbers, sonarjs, cspell…)
```

Cada gate se testea aislado: `node --test plugins/gates/hooks/gates/<id>/test.mjs`.

> Este repositorio trae su propio `.ai/config.json` que apaga localmente los gates que
> darían falso positivo al **editar los gates mismos** (por ejemplo, `audit-before-build`
> cree que estás "construyendo una herramienta" cuando en realidad editas un gate
> existente). Por eso está versionado: el repo se comporta igual en cualquier máquina.

## Requisitos

Node **≥ 22.5** (el gate `forge-flow` usa `node:sqlite`, disponible desde esa versión).

## Licencia

MIT.
