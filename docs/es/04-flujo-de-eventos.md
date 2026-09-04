# Flujo de eventos

El plugin convierte eventos variables de OpenCode en un estado interno estable. Esa conversión ocurre principalmente en `src/events.ts` y después pasa por `src/state.ts` y `src/render.ts`.

La regla más importante:

> Un evento no se muestra directamente. Primero se interpreta como evidencia, después se guarda en el estado y recién al final se decide qué fila visible corresponde.

## Flujo completo

```txt
Evento de OpenCode
  ↓
applySubagentEvent(event, state)
  ↓
Extracción de evidencia
  ↓
Mutación de StatuslineState
  ↓
refreshDerivedFields(state)
  ↓
collapseSubagentWorkItems(state.children)
  ↓
Sidebar / home footer
```

## Eventos que escucha el plugin

El plugin TUI se suscribe a estos eventos:

| Evento                 | Uso principal                                    |
| ---------------------- | ------------------------------------------------ |
| `session.created`      | Detectar una sesión hija real.                   |
| `session.updated`      | Actualizar datos de una sesión hija.             |
| `session.status`       | Normalizar estado de una sesión.                 |
| `session.idle`         | Marcar una sesión como terminada.                |
| `session.error`        | Marcar una sesión como fallida.                  |
| `message.updated`      | Encontrar evidencia de subtareas terminadas.     |
| `message.part.updated` | Detectar subtareas o wrappers `task`/`delegate`. |

Estos eventos no siempre llegan con la misma forma. Por eso `src/events.ts` busca datos en varios lugares del payload.

## Caso 1: aparece una sesión real

Este es el caso más directo.

```txt
session.created
  ↓
se extrae sessionID + parentID
  ↓
se crea un child source: "session"
  ↓
se cuenta una ejecución real
  ↓
la sidebar puede mostrarlo como running
```

Ejemplo conceptual:

```ts
{
  type: "session.created",
  properties: {
    sessionID: "ses_child",
    info: {
      id: "ses_child",
      parentID: "ses_parent"
    }
  }
}
```

Resultado esperado:

```ts
children["ses_child"] = {
  id: "ses_child",
  source: "session",
  parentID: "ses_parent",
  targetSessionID: "ses_child",
  status: "running",
};
```

Como `source: "session"` representa trabajo real, `totalExecuted` sube una vez.

## Caso 2: aparece una parte `subtask`

A veces OpenCode expone trabajo delegado como una parte de mensaje antes de exponer una sesión hija real.

```txt
message.part.updated
  ↓
part kind/type = subtask
  ↓
se crea child id subtask:<partID>
  ↓
puede contar como fallback provisional
  ↓
si luego aparece una sesión real, se reconcilia
```

Ejemplo conceptual:

```ts
{
  type: "message.part.updated",
  properties: {
    sessionID: "ses_parent",
    messageID: "msg_1",
    part: {
      id: "prt_1",
      type: "subtask",
      description: "Review current diff"
    }
  }
}
```

Resultado esperado:

```ts
children["subtask:prt_1"] = {
  id: "subtask:prt_1",
  source: "subtask",
  parentID: "ses_parent",
  messageID: "msg_1",
  title: "Review current diff",
  status: "running",
};
```

Un `subtask` puede ser útil aunque todavía no exista `targetSessionID`. El plugin lo usa como señal temprana para mostrar que hay trabajo delegado activo.

## Caso 3: aparece un wrapper `task` o `delegate`

OpenCode también puede emitir partes de mensaje que representan tool calls. Para este plugin, las más importantes son `task` y `delegate`.

```txt
message.part.updated
  ↓
part tool = task/delegate
  ↓
se crea child id tool:<partID>
  ↓
source: "tool"
  ↓
no cuenta como ejecución
  ↓
aporta evidencia de estado o target
```

Ejemplo conceptual:

```ts
{
  type: "message.part.updated",
  properties: {
    sessionID: "ses_parent",
    messageID: "msg_1",
    part: {
      id: "prt_tool",
      tool: "task",
      state: "running",
      description: "Run tests"
    }
  }
}
```

Resultado esperado:

```ts
children["tool:prt_tool"] = {
  id: "tool:prt_tool",
  source: "tool",
  parentID: "ses_parent",
  messageID: "msg_1",
  title: "Run tests",
  status: "running",
};
```

Este child puede aparecer en el estado y aportar información, pero **no incrementa `totalExecuted`**.

## Por qué los wrappers no cuentan

Un wrapper `tool:*` no es necesariamente una ejecución real. Puede ser solamente la representación técnica de una llamada que después produce una sesión real.

Si el plugin contara el wrapper y después contara la sesión, inflaría el total.

Por eso la regla es:

| Source    | Cuenta                          |
| --------- | ------------------------------- |
| `session` | Sí.                             |
| `subtask` | Solo como fallback provisional. |
| `tool`    | No.                             |

## Correlación entre wrapper, subtask y sesión

El mismo trabajo delegado puede aparecer varias veces con formas distintas.

Ejemplo:

```txt
1. message.part.updated -> tool:prt_tool
2. message.part.updated -> subtask:prt_subtask
3. session.created      -> ses_child
```

El plugin intenta relacionar esas piezas usando evidencia como:

- `targetSessionID`;
- `parentID`;
- `messageID`;
- IDs de sesión encontrados en metadata;
- IDs de sesión parseados desde output, por ejemplo `task_id: ses_...`;
- título, descripción o agente;
- actividad y timestamps.

Si la correlación es segura, el render puede mostrar una sola fila en vez de tres.

Si la correlación es ambigua, no se fuerza.

## Target session

`targetSessionID` es el ID de la sesión real navegable detrás de una fila sintética.

Ejemplo:

```ts
children["subtask:prt_1"] = {
  id: "subtask:prt_1",
  source: "subtask",
  targetSessionID: "ses_child",
};
```

Esto significa:

- la fila visible puede seguir usando el título del `subtask`;
- la navegación puede abrir `ses_child`;
- los datos terminales de `ses_child` pueden fusionarse en la fila sintética;
- el contador puede reconciliarse hacia la sesión real.

## Estados terminales

Los estados internos son solo tres:

```txt
running | done | error
```

OpenCode puede usar muchas palabras distintas. `src/reconcile.ts` las normaliza.

| OpenCode                                                                 | Estado interno |
| ------------------------------------------------------------------------ | -------------- |
| `busy`, `running`, `pending`, `queued`, `working`, `compacting`, `retry` | `running`      |
| `idle`, `done`, `completed`, `complete`, `success`, `succeeded`          | `done`         |
| `error`, `failed`, `failure`, `cancelled`, `canceled`, `aborted`         | `error`        |

Si una palabra no se reconoce, se trata como inconclusa. El plugin evita adivinar.

## Cierre por eventos de sesión

Una sesión real puede terminar por varios caminos:

```txt
session.idle  -> done
session.error -> error
session.status con valor terminal -> done/error
```

Cuando se marca una sesión como terminal, `markChildStatus()` también puede actualizar filas sintéticas que apuntan a esa misma sesión mediante `targetSessionID`.

Eso permite que una fila `subtask:*` muestre `done` aunque la evidencia terminal haya llegado por `ses_*`.

## Cierre por mensajes completados

No toda finalización llega como evento de sesión. A veces la evidencia aparece en mensajes o partes de mensajes.

El plugin puede usar:

- tool call completado;
- output con `task_id`;
- mensaje assistant completado;
- metadata de error;
- estado consultado durante hydration o reconcile.

Esto es importante para flujos síncronos donde la sesión real no aparece inmediatamente o el wrapper técnico es la primera señal disponible.

## Hydration

La TUI no depende solo de eventos live.

Cuando se navega a una sesión, `src/tui.tsx` intenta hidratar subagentes previos consultando APIs de OpenCode:

- sesiones hijas;
- mensajes;
- partes de mensajes;
- estados de sesión.

Después transforma esa información en eventos sintéticos internos y los pasa por el mismo pipeline.

```txt
OpenCode client API
  ↓
eventos sintéticos
  ↓
applySubagentEvent()
  ↓
estado/render normal
```

Esto permite reconstruir actividad que ocurrió antes de que la TUI actual estuviera escuchando.

## Reconciliación de running viejos

Algunos hijos pueden quedar como `running` por falta de evento terminal.

El plugin no los cierra automáticamente por edad. Primero intenta conseguir evidencia:

1. estado vivo de la TUI;
2. estado de sesión del cliente OpenCode;
3. mensajes del child;
4. actividad reciente del parent;
5. umbral de stale-running.

Solo cuando las condiciones son seguras puede cerrar un candidato viejo.

Esto evita marcar como terminado un subagente que quizá sigue trabajando.

## Tokens y contexto

La información de tokens/contexto puede llegar por varias fuentes:

- payload del evento;
- estado vivo de TUI;
- base SQLite de OpenCode;
- logs recientes.

El plugin mezcla esa evidencia de forma best-effort. Si no hay datos, la fila se muestra sin tokens/contexto.

## Comportamiento fail-closed

Muchos casos se resuelven con una regla conservadora:

> Si no hay evidencia suficiente para correlacionar, cerrar o deduplicar, el plugin no inventa una relación.

Ejemplos:

| Situación                                     | Comportamiento                   |
| --------------------------------------------- | -------------------------------- |
| Output con múltiples `ses_*` posibles         | No se elige uno al azar.         |
| Dos subtasks iguales en el mismo mensaje      | No se cierra uno por suposición. |
| Wrapper sin target y varias sesiones hermanas | No se backfillea target.         |
| Probe de sesión falla                         | No se aplica stale fallback.     |
| Estado desconocido                            | Se mantiene inconcluso.          |

## Resumen del flujo

```txt
Evento live o hidratado
  ↓
¿Es sesión, subtask o tool?
  ↓
¿Hay parent/message/target/session evidence?
  ↓
Actualizar estado
  ↓
Normalizar status/tokens/timestamps
  ↓
Reconciliar contadores si corresponde
  ↓
Renderizar filas visibles
  ↓
Mostrar en la TUI
```

## Archivos relacionados

| Archivo                 | Qué mirar                                                   |
| ----------------------- | ----------------------------------------------------------- |
| `src/events.ts`         | Extracción y aplicación de eventos.                         |
| `src/state.ts`          | Mutaciones, contadores y persistencia.                      |
| `src/reconcile.ts`      | Normalización y cierre conservador.                         |
| `src/render.ts`         | Collapse y visibilidad final.                               |
| `src/tui.tsx`           | Suscripción a eventos, hydration y mantenimiento periódico. |
| `src/events.test.ts`    | Casos de eventos y correlación.                             |
| `src/reconcile.test.ts` | Casos fail-closed y stale-running.                          |
