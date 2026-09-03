# Modelo de estado y contadores

El estado interno del plugin vive en `src/state.ts`. Su trabajo es guardar evidencia sobre subagentes, mantener invariantes y contar ejecuciones reales sin duplicar wrappers técnicos.

La idea principal:

> `children` guarda lo que el plugin sabe. `totalExecuted` cuenta trabajo real. La UI puede mostrar menos filas que las guardadas.

## Estado central

El estado principal se llama `StatuslineState`.

Forma simplificada:

```ts
type StatuslineState = {
  children: Record<string, ChildSessionState>;
  countedChildIDs: string[];
  totalExecuted: number;
  updatedAt: string;
};
```

| Campo             | Significado                                                         |
| ----------------- | ------------------------------------------------------------------- |
| `children`        | Mapa de work items conocidos: sesiones reales, subtasks y wrappers. |
| `countedChildIDs` | Identidades reales `ses_*` observadas que ya fueron contadas como ejecución. |
| `totalExecuted`   | Total semántico de ejecuciones reales.                              |
| `updatedAt`       | Última actualización derivada del estado.                           |

## ChildSessionState

Cada entrada de `children` representa un item relacionado con trabajo delegado.

Forma simplificada:

```ts
type ChildSessionState = {
  id: string;
  parentID?: string;
  messageID?: string;
  targetSessionID?: string;
  source?: "session" | "subtask" | "tool";
  status: "running" | "done" | "error";
  title?: string;
  summary?: string;
  agent?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  color?: string;
  tokenState?: ChildTokenState;
};
```

## Sources

El campo `source` es clave para entender el comportamiento del plugin.

| Source    | Qué representa                                    | Ejemplo de ID   | Cuenta como ejecución       |
| --------- | ------------------------------------------------- | --------------- | --------------------------- |
| `session` | Sesión hija real de OpenCode.                     | `ses_abc123`    | Sí, una vez.                |
| `subtask` | Representación sintética de una parte de mensaje. | `subtask:prt_1` | No. |
| `tool`    | Wrapper técnico de una tool call.                 | `tool:prt_2`    | No.                         |

El contador se basa en esta clasificación, no en duración ni visibilidad.

## Estados internos

El plugin reduce muchos estados posibles a tres estados internos:

```txt
running | done | error
```

| Estado    | Significado                                     |
| --------- | ----------------------------------------------- |
| `running` | Hay evidencia de trabajo activo o pendiente.    |
| `done`    | Hay evidencia de finalización exitosa/inactiva. |
| `error`   | Hay evidencia de error, cancelación o fallo.    |

El color y la duración son campos derivados. Se actualizan al refrescar el estado.

## Diferencia entre ID y targetSessionID

`id` identifica la entrada interna del estado.

`targetSessionID` identifica la sesión real navegable, si se conoce.

Ejemplo:

```ts
{
  id: "subtask:prt_1",
  source: "subtask",
  targetSessionID: "ses_child"
}
```

Esto significa:

- el item interno sigue siendo el subtask;
- la sesión real asociada es `ses_child`;
- la UI puede navegar a `ses_child`;
- la fila sintética sigue excluida de los contadores de ejecución;
- observar la sesión real `ses_child` agrega esa identidad una sola vez;
- el render puede fusionar datos de la sesión real en la fila sintética.

## Regla de conteo

El plugin cuenta ejecuciones reales, no eventos ni filas.

Reglas:

1. Las filas sintéticas `source: "tool"` y `source: "subtask"` nunca entran en `countedChildIDs` ni incrementan `totalExecuted`.
2. `source: "session"` incrementa una vez por cada identidad real `ses_*` observada.
3. Una fila sintética puede aparecer antes que la sesión real y luego aportar correlación o navegación mediante `targetSessionID` sin contar.
4. Cuando aparece la sesión real, solo su identidad `ses_*` entra en `countedChildIDs`.
5. Las actualizaciones repetidas de la misma sesión real no vuelven a contar.

## Por qué `tool` no cuenta

Un wrapper `tool:*` representa la llamada técnica, no necesariamente el trabajo real.

Ejemplo:

```txt
tool:prt_task  -> wrapper de task
ses_child      -> sesión real creada por esa task
```

Si ambos contaran, una sola delegación aparecería como dos ejecuciones.

Por eso:

```txt
tool:prt_task = evidencia, no ejecución
ses_child     = ejecución real
```

Incluso si el wrapper tiene duración mayor a cero, sigue sin contar. La regla se basa en `source`, no en heurísticas de tiempo.

## Conteo de sesiones reales

Cuando llega una sesión real:

```ts
upsertRunningChild(state, {
  id: "ses_child",
  source: "session",
  parentID: "ses_parent",
  targetSessionID: "ses_child",
});
```

El plugin:

1. crea o actualiza `children["ses_child"]`;
2. verifica si esa identidad ya fue contada;
3. si no fue contada, suma `totalExecuted`;
4. agrega la identidad a `countedChildIDs`.

Resultado conceptual:

```ts
countedChildIDs = ["ses_child"];
totalExecuted = 1;
```

Si llega otra actualización de `ses_child`, no vuelve a sumar.

## Filas sintéticas antes de una sesión real

A veces aparece un `subtask` antes que la sesión real.

```txt
subtask:prt_1 aparece primero
ses_child aparece después
```

Mientras no se conozca la sesión real, el subtask puede ser visible, pero sigue sin contar.

Estado inicial:

```ts
countedChildIDs = [];
totalExecuted = 0;
```

Agregar `targetSessionID` puede hacer que la fila sintética sea correlacionable y navegable. Ese dato por sí solo tampoco cuenta una ejecución. Después se observa la sesión real:

```ts
children["subtask:prt_1"].targetSessionID = "ses_child";
children["ses_child"] = { source: "session", id: "ses_child" };
```

La identidad real cuenta una vez:

```ts
countedChildIDs = ["ses_child"];
totalExecuted = 1;
```

El render puede conservar el título sintético y fusionar estado, tiempos o tokens de la sesión real en una sola fila visible. La visibilidad y la correlación no cambian la regla de conteo.

## Correlación sin rekeying sintético

No existe una identidad sintética contada que deba cambiarse. Un ID `subtask:*` o `tool:*` queda fuera de `countedChildIDs`, aunque obtenga un `targetSessionID` confiable.

Ejemplo:

```txt
Antes de la sesión real: countedChildIDs = []
Después de observarla:   countedChildIDs = ["ses_child"]
```

La proyección puede correlacionar entradas cuando:

- una fila sintética obtiene un `targetSessionID` confiable;
- aparece una sesión real correlacionada.

La sesión real aporta la única identidad de ejecución. La fila sintética correlacionada puede aportar un título útil o un destino de navegación sin inflar `totalExecuted`.

## Persistencia

El estado puede guardarse como JSON.

Por defecto, las rutas se resuelven con:

```txt
$XDG_RUNTIME_DIR/opencode-subagent-statusline/<instance>/state.json
```

Si `XDG_RUNTIME_DIR` no existe, se usa el tempdir del sistema.

También existe `status.txt` junto a `state.json` para el snapshot textual de la TUI.

Variables relevantes:

| Variable                                        | Uso                                                |
| ----------------------------------------------- | -------------------------------------------------- |
| `OPENCODE_SUBAGENT_STATUSLINE_STATE`            | Sobrescribe la ruta de `state.json`.               |
| `OPENCODE_SUBAGENT_STATUSLINE_INSTANCE`         | Define el nombre de instancia.                     |
| `XDG_RUNTIME_DIR`                               | Base por defecto para archivos locales de la TUI.  |

La TUI es dueña de estos snapshots, pero su estado autoritativo vive en memoria mientras está activa.

## Escritura de snapshots

La TUI escribe `state.json` y `status.txt` de forma best-effort mediante los helpers compartidos de persistencia. Las escrituras conservan permisos exclusivos para el propietario y reemplazo atómico cuando el filesystem lo permite.

Antes de escribir un snapshot, se refrescan los campos derivados actuales y los detalles de tokens/modelo de los children modificados. Los archivos persistidos exponen estado local actual; no son entradas para restaurar el inicio ni recuperar tokens.

La hidratación de tokens/contexto usa el estado vivo en memoria y los eventos, junto con `session.messages`. Los snapshots persistidos, la base de datos local de OpenCode y los archivos de log recientes no son fuentes de recuperación.

## Campos derivados

Al refrescar estado, el plugin recalcula o normaliza campos como:

| Campo           | Origen                                                      |
| --------------- | ----------------------------------------------------------- |
| `elapsedMs`     | Diferencia entre `startedAt` y `endedAt` o tiempo actual.   |
| `color`         | Derivado de `status`.                                       |
| `updatedAt`     | Último cambio conocido.                                     |
| tokens/contexto | Evidencia viva en memoria/eventos más `session.messages`.   |

También poda filas terminales viejas para evitar crecimiento indefinido.

## Poda de hijos terminales

El estado conserva hijos `done` o `error` durante un tiempo limitado: hasta 3
días, con un límite de 1.500 filas terminales.

El objetivo:

- que el usuario vea completions recientes;
- evitar que el estado crezca sin límite;
- preservar `totalExecuted` aunque algunas filas terminales se poden.

La poda de filas no implica reducir `totalExecuted`.

## Mutaciones principales

| Helper                   | Responsabilidad                                   |
| ------------------------ | ------------------------------------------------- |
| `createEmptyState()`     | Crear estado inicial.                             |
| `upsertRunningChild()`   | Crear o actualizar un child como `running`.       |
| `markChildStatus()`      | Marcar child como `done` o `error`.               |
| `upsertChildDetails()`   | Mezclar título, resumen, agente, tokens y target. |
| `refreshDerivedFields()` | Recalcular duración, color, poda y timestamps.    |
| `saveState()`            | Guardar estado normalizado en disco.              |

## Ejemplo completo

### 1. Llega wrapper técnico

```ts
children["tool:prt_task"] = {
  id: "tool:prt_task",
  source: "tool",
  status: "running",
};

countedChildIDs = [];
totalExecuted = 0;
```

### 2. Llega subtask provisional

```ts
children["subtask:prt_1"] = {
  id: "subtask:prt_1",
  source: "subtask",
  status: "running",
};

countedChildIDs = [];
totalExecuted = 0;
```

### 3. Aparece sesión real

```ts
children["ses_child"] = {
  id: "ses_child",
  source: "session",
  targetSessionID: "ses_child",
  status: "running",
};

children["subtask:prt_1"].targetSessionID = "ses_child";
```

### 4. Se reconcilia el conteo

```ts
countedChildIDs = ["ses_child"];
totalExecuted = 1;
```

### 5. Termina la sesión

```ts
children["ses_child"].status = "done";
children["subtask:prt_1"].status = "done";
```

El render puede mostrar una sola fila visible, aunque el estado conserve varias evidencias.

## Invariantes que debe respetar cualquier cambio

Cuando modifiques este proyecto, verificá estas reglas:

- Las filas sintéticas `tool:*` y `subtask:*` no deben entrar en `countedChildIDs` ni incrementar `totalExecuted`.
- Una sesión real debe contar una sola vez.
- Una fila sintética puede seguir visible, correlacionarse y volverse navegable sin contar como ejecución.
- `targetSessionID` debe usarse solo cuando la correlación sea segura.
- Los fallos al escribir snapshots no deben romper la TUI.
- La poda de hijos no debe alterar el total histórico ejecutado.
- Los tests de `state`, `events` y `render` deben cubrir cualquier cambio de conteo.

## Tests relacionados

| Archivo                 | Qué confirma                                              |
| ----------------------- | --------------------------------------------------------- |
| `src/state.test.ts`     | Conteo de sesiones reales, exclusión de filas sintéticas, persistencia y sanitización de snapshots. |
| `src/events.test.ts`    | Extracción de targets y correlación segura.               |
| `src/render.test.ts`    | Collapse visual sin duplicar filas.                       |
| `src/reconcile.test.ts` | Cierre conservador de estados viejos.                     |
