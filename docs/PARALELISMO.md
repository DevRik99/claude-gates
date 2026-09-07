# Varios agentes en paralelo: dónde se pisan

Tres formas distintas de colisión, con mecanismos distintos y arreglos distintos. La primera
es la que ocurrió de verdad en la sesión del 6 de septiembre de 2026 y bloqueó a un agente
entero durante minutos.

---

## 1. Interferencia de bloqueo — la tarea de otro te congela

**El mecanismo.** Dos gates leen la lista de tareas del **proyecto entero**:

| Gate | Qué deniega | Qué lee |
|---|---|---|
| `require-task-split` | todo `write` y `execution` | `.ai/tasks/active.json` |
| `stop-pending` | terminar el turno | `.ai/tasks/active.json` |

Y una tarea **no tiene dueño**. Su forma es:

```
{ id, title, description, status, size, createdAt, messages[] }
```

No hay `owner`, ni `sessionId`, ni `agentId`. Así que `require-task-split` no puede
distinguir *"hay una tarea sin dividir"* de *"hay una tarea sin dividir **mía**"*.

**La consecuencia.** El agente B registra una tarea `medium`. El agente A —que no tiene nada
que ver con ella— pierde `Write`, `Edit` y `Bash` en todo el proyecto. No puede ni dividirla,
porque no es suya y no conoce su alcance. Queda congelado por algo que no hizo.

El radio de la explosión es el proyecto; la causa es un solo agente. Ese desajuste **es** el
bug.

**El arreglo.** Dar dueño a la tarea y filtrar por él:

1. El payload de todo hook ya trae `session_id`. Al registrar, se guarda como `owner`.
2. `require-task-split` solo cuenta las tareas sin dividir **del owner que llama**.
3. `stop-pending` solo cuenta las tareas abiertas **del owner que llama**.
4. Una tarea sin `owner` (las de antes del cambio) sigue contando para todos: degradar hacia
   el comportamiento actual es seguro; degradar hacia "no bloquea a nadie" apagaría el gate en
   silencio.

Con eso, el agente B se bloquea a sí mismo hasta que divida lo suyo, y el agente A no se
entera.

---

## 2. Colisión de ficheros — `OWNS` no lo aplica nadie

**El mecanismo.** El sistema ya tiene el concepto de propiedad de ficheros: el hook de
registro y el mensaje de `require-task-split` piden declarar `--description "OWNS: <paths>"`,
y la regla dice *"no two sub-tasks modify the same file"*.

Pero `OWNS` **solo existe como texto libre dentro de `description`**. Está en los mensajes
que se imprimen y en ningún sitio más:

```
plugins/gates/hooks/gates/require-task-split/index.mjs:68   (texto del deny)
plugins/tasks/hooks/register-requests.mjs:104,111,113        (texto del prompt)
```

Nada lo parsea. Nada lo compara. Dos agentes pueden declarar `OWNS: src/auth.ts` los dos y
editarlo a la vez sin que salte absolutamente nada.

**La consecuencia.** La disciplina de ownership es una convención que solo se cumple si los
dos agentes deciden cumplirla. Es exactamente la clase de garantía que este repo existe para
no tener.

**El arreglo.** Promover `OWNS` de prosa a dato, y ponerle un gate:

1. `owns: string[]` como campo real de la tarea (el CLI ya recibe la lista; hoy la entierra en
   la descripción).
2. Un gate `file-ownership` en `PreToolUse` sobre el grupo `write`: si el path que se va a
   escribir está en el `owns` de una tarea **activa de otro owner**, denegar.
3. El mensaje encamina, como el resto: dice qué tarea lo reclama, de quién es, y que la
   alternativa es reclamarlo o esperar.

Sin el punto 1 del apartado anterior (`owner`) este gate no se puede escribir: "de otro
owner" no significa nada mientras las tareas no tengan dueño. Por eso el orden importa.

---

## 3. Lost update en el store — conocido y ya mitigado a medias

**El mecanismo.** Escribir `active.json` es atómico (fichero temporal + `rename`), así que
ningún lector ve un fichero a medio escribir. Pero sigue siendo read-modify-write sin
compare-and-swap: dos agentes que cierran tareas a la vez leen la misma lista y el segundo en
escribir pisa el cambio del primero.

Esto **ya está documentado en el propio código**, sin adornos
(`plugins/tasks/hooks/lib/task-store.mjs:94`):

> This narrows the window, it does not close it: a genuine read-modify-write race between two
> processes still needs a lock.

**El arreglo.** El patrón ya existe en este mismo ecosistema: forge protege el avance de fase
con un optimistic lock (`UPDATE runs SET ... WHERE id = ? AND current_phase = ?`, y si
`changes !== 1` lanza `StalePhaseError` en vez de avanzar en silencio). El task store puede
hacer lo mismo con una versión o el `mtime` leído: si cambió entre el read y el write,
reintentar en lugar de pisar.

---

## Nota aparte: forge y el paralelismo

`resolveRun` desambigua por `cwd`. Dos agentes trabajando en el mismo proyecto resuelven **el
mismo run**, y por tanto compiten por la misma fase. Ahí el optimistic lock sí protege: el
segundo cierre recibe `StalePhaseError` en vez de saltarse una fase.

Pero eso es protección, no paralelismo. Para trabajo realmente concurrente dentro de forge hay
dos modelos, y conviene elegir a conciencia:

- **Un run por agente.** Cada uno con su pipeline y su timeline. Independientes de verdad.
- **Un run, paralelismo dentro de la fase.** Es lo que ya expresa `delegationBrief`: `build`
  abre un subagente por bloque, y los bloques son disjuntos por construcción desde `plan`.
  El paralelismo vive *dentro* de una fase, no entre fases.

El segundo es el que el pipeline ya está diseñado para soportar. El primero necesita que la
DB distinga runs por algo más fino que el `cwd`.

---

## Orden recomendado

1. `owner` en la tarea + filtrado en `require-task-split` y `stop-pending`. Desbloquea el
   problema real y es requisito de lo siguiente.
2. `owns` como campo + gate `file-ownership`.
3. Optimistic lock en el task store.

El 1 es el que duele hoy. El 2 es el que evita el daño silencioso (dos agentes pisándose un
fichero sin que nadie se entere). El 3 es el más raro de disparar y el que menos cuesta perder.

---

## Por qué `force-parallel` nunca se activó (sesión del 6-sep-2026)

No falló ni estaba mal configurado. Estaba **encendido todo el tiempo**:

```
.ai/config.json  → warnSequentialDelegations { enabled: true, sequentialThreshold: 3,
                                               sequentialWindowMs: 120000 }
claude-gates status → on   force-parallel   warnSequentialDelegations   (project)
```

Y aun así registró **cero decisiones** en `.ai/gates-log.jsonl`.

La causa es su matcher: `Agent|Task|invoke_subagent|mcp__.*`. **El hook solo se ejecuta cuando
hay una delegación.** Su contador vive en `session-state` y solo se incrementa dentro del hook.
En toda la sesión hubo **0 bloques `tool_use` con `name: Agent` o `Task`**, así que el hook
nunca llegó a correr, el contador nunca salió de 0, y el umbral de 3 nunca se alcanzó.

El gate mide **el espaciado entre delegaciones**. No puede medir **la ausencia de delegación**.
Un agente que lo hace todo él mismo es invisible para él.

Hubo además una segunda capa: una instrucción de sesión prohibía usar la tool `Agent` salvo que
el usuario, un CLAUDE.md o una skill lo pidieran. O sea, una regla que impedía delegar y un gate
ciego a que no se delegaba: ninguno podía corregir al otro.

### El gate que falta: `finish-or-delegate`

Lo que hace falta no es sobre delegaciones en serie, sino sobre **cambiar de aguja con trabajo a
medias**. Ahora es implementable, porque las tareas ya tienen `owner` y `claimedAt`:

> Con una tarea **reclamada por ti y sin cerrar**, cuando llega una nueva: o **delegas la nueva**
> a un subagente, o **aparcas la tuya** con causa (`task block <id> --reason`). Soltarla y saltar
> no es una opción.

Señales que ya están disponibles sin inventar nada: `ownedBy(caller)` da lo que sostienes,
`claimedAt` da desde cuándo, y el grupo `delegation` dice si la nueva se está repartiendo o
absorbiendo. A diferencia de `force-parallel`, este sí observa el caso de "no delegó nunca",
porque su disparador es el registro de una tarea, no la delegación.

### El nombre promete más de lo que hace

`force-parallel` no fuerza paralelizar. Su `configKey` es el honesto:
`warnSequentialDelegations`. Vigila el **ritmo de las delegaciones que ya existen**.

La primera línea de su check lo cierra todo (`force-parallel/index.mjs:62`):

```js
if (!toolInGroups(toolName, ['delegation'])) return;
```

Si la tool no es una delegación, sale. No hay estado que actualizar ni nada que contar.

Y su conteo (`nextCount`, líneas 43-48):

| Separación entre delegaciones | Efecto |
|---|---|
| > `sequentialWindowMs` (120s) | reinicia el contador a 1 |
| < `BATCH_GAP_MS` (2s) | **no penaliza** — se considera un lanzamiento en paralelo |
| entre 2s y 120s | contador +1 |
| contador ≥ `sequentialThreshold` (3) | **deniega**, pidiendo enviarlas en bloque |

Leído en una frase: **convierte delegación en serie en delegación en paralelo**. Es una mejora
de ritmo, no una obligación de delegar. Un agente que nunca delega jamás entra en su radar.

Por eso el gate que falta (`finish-or-delegate`) no puede ser una variante de este: su
disparador tiene que ser algo que ocurra **sin delegar** — el registro de una tarea nueva
mientras sostienes una sin cerrar, o una racha larga de `Edit`/`Write` del agente principal
sobre ficheros independientes.
