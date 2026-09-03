# Arquitectura

El plugin está organizado alrededor de un pipeline: recibir eventos de OpenCode, normalizarlos como estado interno, deduplicar representaciones técnicas y renderizar una vista útil para la TUI.

```txt
OpenCode
  ├─ eventos de sesión
  ├─ eventos de mensaje
  └─ eventos de partes/tool calls
        ↓
src/events.ts
        ↓
src/state.ts
        ↓
src/projection.ts
        ↓
src/render.ts
        ↓
src/tui.tsx
Plugin TUI principal
Sidebar / footer / snapshots locales
```

## Mapa de módulos

| Archivo                          | Responsabilidad                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/tui.tsx`                    | Plugin TUI principal: slots, sidebar, footer, hidratación a toda profundidad, reconciliación, navegación, persistencia y ciclo de vida. |
| `src/events.ts`                  | Convierte eventos de OpenCode en mutaciones del estado interno.                                        |
| `src/state.ts`                   | Define el modelo de datos, contadores, persistencia y helpers de mutación.                             |
| `src/projection.ts`              | Construye el índice de linaje en caché, las filas del subárbol, sus profundidades y contadores.       |
| `src/render.ts`                  | Formatea filas, colapsa duplicados, filtra visibilidad y arma el statusline textual.                   |
| `src/reconcile.ts`               | Normaliza estados de OpenCode y ayuda a cerrar casos `running` viejos de forma segura.                 |
| `src/tui-commands.ts`            | Registra comandos y keybindings, especialmente `Alt+B`.                                                |
| `src/*.test.ts`                  | Tests unitarios del núcleo determinístico.                                                             |

## Entrypoints

### TUI plugin

Fuente: `src/tui.tsx`

Es el único endpoint de plugin soportado por el paquete, disponible mediante dos entrypoints:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
```

Responsabilidades principales:

- registrar el plugin TUI con id `subagent-statusline.tui`;
- montar la UI con Solid/OpenTUI;
- escuchar eventos relevantes de OpenCode;
- renderizar la sidebar de subagentes;
- renderizar un resumen inferior en home;
- registrar comandos y atajos;
- hidratar subagentes existentes al navegar entre sesiones;
- reconciliar estados viejos que quedaron como `running`;
- persistir los snapshots TUI `state.json` y `status.txt`;
- escribir `tui-events.log` cuando está activo el diagnóstico de eventos.

## Modelo interno

El estado central vive en `src/state.ts`.

De forma simplificada:

```ts
type StatuslineState = {
  children: Record<string, ChildSessionState>;
  countedChildIDs: string[];
  totalExecuted: number;
  updatedAt: string;
};
```

Cada child representa una pieza de trabajo relacionada con subagentes:

```ts
type ChildSessionState = {
  id: string;
  parentID?: string;
  targetSessionID?: string;
  source?: "session" | "subtask" | "tool";
  status: "running" | "done" | "error";
  title?: string;
  summary?: string;
  agent?: string;
  startedAt?: string;
  endedAt?: string;
  tokenState?: ChildTokenState;
};
```

La documentación completa del modelo va en `05-modelo-de-estado-y-contadores.md`, pero la regla base es:

> El estado guarda evidencia. El render decide qué se muestra. El contador decide qué fue ejecución real.

## Sources: session, subtask y tool

El plugin necesita distinguir de dónde viene cada work item.

| Source    | Origen típico                                             | Uso                                                        |
| --------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `session` | Eventos `session.*` de OpenCode con una sesión hija real. | Es la fuente más fuerte. Cuenta como ejecución real.       |
| `subtask` | Partes de mensaje que describen una subtarea.             | Aporta evidencia temprana o provisional de visualización y correlación, pero no cuenta como ejecución. |
| `tool`    | Tool calls como `task` o `delegate`.                      | Aporta evidencia de estado, pero no cuenta como ejecución. |

Esta separación existe porque OpenCode puede avisar primero sobre un wrapper técnico y después revelar la sesión real, o puede emitir información incompleta en distintos eventos.

## Pipeline de eventos

`src/events.ts` recibe eventos de OpenCode y decide si hay algo relevante para el estado.

Eventos principales:

| Evento                 | Qué puede significar                                      |
| ---------------------- | --------------------------------------------------------- |
| `session.created`      | Apareció una sesión hija real.                            |
| `session.updated`      | Cambió información de una sesión.                         |
| `session.status`       | Cambió el estado normalizado de una sesión.               |
| `session.idle`         | La sesión quedó inactiva, normalmente `done`.             |
| `session.error`        | La sesión falló.                                          |
| `message.updated`      | Puede traer evidencia de finalización de subtareas.       |
| `message.part.updated` | Puede representar subtareas o wrappers `task`/`delegate`. |

El objetivo de `events.ts` no es renderizar. Su trabajo es transformar señales variables en mutaciones consistentes sobre `StatuslineState`.

## Estado y contadores

`src/state.ts` concentra las invariantes importantes:

- crear o actualizar hijos corriendo;
- marcar hijos como `done` o `error`;
- mezclar detalles como título, resumen, agente y tokens;
- refrescar duración y campos derivados;
- persistir snapshots TUI de estado y texto;
- podar hijos terminales viejos;
- mantener `totalExecuted` sin duplicados.

Reglas críticas:

- las filas sintéticas `source: "tool"` y `source: "subtask"` no entran en `countedChildIDs` ni incrementan `totalExecuted`;
- cada sesión real `ses_*` observada cuenta una sola vez;
- un subtask puede aparecer antes, correlacionarse con una sesión real posterior y permitir navegar hacia ella sin contarse a sí mismo;
- cuando aparece la sesión real, su identidad `ses_*` es la única que entra en los contadores de ejecución;
- los snapshots persistidos mantienen disponible el estado compartido y el render textual, pero no aportan evidencia de tokens.

## Renderizado

`src/render.ts` no imprime simplemente `state.children`.

Antes de mostrar algo:

1. selecciona el subárbol completo de descendientes retenidos;
2. colapsa duplicados y correlaciona sesiones reales con filas provisionales;
3. ordena hermanos con las reglas actuales de prioridad;
4. emite padres antes que hijos y asigna una profundidad a cada fila;
5. filtra `done` viejos mientras conserva errores y elementos `running` visibles;
6. arma el resumen agregado.

Esto explica por qué puede haber más children en el estado que filas visibles en la UI.

## TUI runtime

`src/tui.tsx` es el módulo más grande porque combina varias responsabilidades de integración con OpenCode.

Responsabilidades principales:

### 1. Inicialización

Crea estado en memoria, registra comandos, prepara slots y configura listeners de eventos.

### 2. Slots visuales

Registra contenido para:

- `sidebar_content`;
- `home_bottom`;
- `home_prompt`;
- `session_prompt`.

Los slots de prompt se usan para preservar referencias de foco y compatibilidad con distintas formas de props de OpenCode.

### 3. Sidebar

La sidebar muestra el árbol completo de descendientes retenidos de la sesión actual. El resumen de home y el render textual de `status.txt` siguen siendo globales entre sesiones.

Soporta:

- expandir/colapsar;
- habilitar/deshabilitar sección;
- scroll;
- foco con teclado;
- navegación con `j/k` y flechas;
- abrir una sesión hija con `Enter` o click cuando hay `targetSessionID` navegable.

### 4. Hydration

Cuando se navega a una sesión, el plugin recorre `session.children(parentID)` de forma iterativa desde la sesión visible. La búsqueda en anchura usa concurrencia fija, consulta cada ID real una sola vez y sigue por todas las profundidades descubiertas. Un conjunto de visitados evita ciclos y consultas duplicadas. Un cambio de ruta o una cancelación detiene el trabajo obsoleto.

La proyección de linaje compartida selecciona una vez el subárbol completo para cada snapshot inmutable. Correlaciona duplicados, ordena hermanos por prioridad y emite un recorrido en profundidad con cada padre antes que sus hijos. Solo las relaciones de sesiones reales pueden extender el linaje. Los targets sintéticos sirven para correlación y navegación, nunca como evidencia de ascendencia.

### 5. Reconciliación

Un intervalo revisa subagentes que quedaron `running` durante mucho tiempo.

La reconciliación no cierra todo por timeout. Primero busca evidencia en estado TUI, estado de sesión y mensajes. Si no hay evidencia suficiente, se comporta de forma conservadora.

### 6. Tokens/contexto

La hidratación de tokens usa únicamente el estado vivo de la TUI y la API `session.messages`. La base de datos local, `state.json`, `status.txt` y los archivos de log no se usan para recuperar evidencia de tokens. Si OpenCode no expone esa información, la UI sigue funcionando sin mostrar esos datos.

## Reconciliación de estados

`src/reconcile.ts` contiene helpers para interpretar estados de OpenCode y evitar cierres inseguros.

Ejemplos:

| OpenCode                                                                 | Estado interno |
| ------------------------------------------------------------------------ | -------------- |
| `busy`, `running`, `pending`, `queued`, `working`, `compacting`, `retry` | `running`      |
| `idle`, `done`, `completed`, `complete`, `success`, `succeeded`          | `done`         |
| `error`, `failed`, `failure`, `cancelled`, `canceled`, `aborted`         | `error`        |

Si el estado es desconocido, se considera inconcluso en vez de adivinar.

## Comandos y keybindings

`src/tui-commands.ts` registra comandos de TUI.

Comandos principales:

| Comando                             | Acción                                       |
| ----------------------------------- | -------------------------------------------- |
| `Subagents: Toggle sidebar section` | Activa o desactiva la sección de subagentes. |
| `Subagents: Focus sidebar list`     | Mueve el foco a la lista de subagentes.      |
| `Subagents: Toggle completed history` | Alterna filas completadas retenidas en la sidebar. |

Atajo principal:

```txt
Alt+B
```

Si la API moderna de keymap está disponible, el plugin la usa. Si no, cae al sistema legacy de comandos.

## Testing como contrato de arquitectura

Los tests no son solo verificación; también documentan decisiones de diseño.

| Test                             | Qué protege                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `src/events.test.ts`             | Parsing de eventos, correlación y fail-closed en ambigüedad. |
| `src/state.test.ts`              | Contadores, persistencia, normalización y reglas de sources. |
| `src/render.test.ts`             | Collapse, visibilidad, formato y resumen agregado.           |
| `src/reconcile.test.ts`          | Normalización de estados y reconciliación conservadora.      |
| `src/projection.test.ts`         | Linaje a toda profundidad, correlación, orden, contadores y seguridad ante ciclos. |
| `src/tui-descendant-hydration.test.ts` | Descubrimiento iterativo acotado, cancelación, batch único y respuestas fail-closed. |
| `src/tui-tree-row.test.ts`       | Indentación por profundidad, ajuste en ancho estrecho y navegación anidada. |
| `src/tui.test.ts`                | Ciclo de vida TUI, persistencia, comandos, keybindings y seams de integración. |

Límite actual: la UI visual completa de `src/tui.tsx` no tiene E2E profundo contra el host OpenCode/OpenTUI.

## Archivos de configuración relevantes

| Archivo                         | Rol                                                             |
| ------------------------------- | --------------------------------------------------------------- |
| `package.json`                  | Nombre del paquete, exports, scripts, peers y metadatos de release. |
| `tsup.config.ts`                | Build TUI único que genera `dist/tui.js` y `dist/tui.d.ts`.     |
| `tsconfig.json`                 | TypeScript base para source.                                    |
| `tsconfig.test.json`            | TypeScript para tests.                                          |
| `vitest.config.ts`              | Vitest, coverage y setup.                                       |
| `.github/workflows/ci.yml`      | CI de PR y push a `main`: typecheck, tests, audit y paquete.    |
| `.github/workflows/release.yml` | Publicación por tag estable y notas de GitHub Release.          |

## Decisiones de diseño importantes

1. **El plugin prioriza no romper OpenCode**
   - Muchas operaciones auxiliares son best-effort.

2. **La correlación ambigua no se fuerza**
   - Si no hay una relación segura entre wrapper, subtask y sesión, no se inventa.

3. **El contador es semántico**
   - Cuenta trabajo real, no cantidad de filas ni cantidad de eventos.

4. **La TUI hidrata información histórica**
   - No depende únicamente de eventos live.

5. **Los tokens/contexto son opcionales**
   - Se muestran cuando hay evidencia disponible.

## Siguiente lectura

Para profundizar, seguí con:

- `04-flujo-de-eventos.md` _(pendiente)_
- `05-modelo-de-estado-y-contadores.md` _(pendiente)_
- `06-renderizado-y-deduplicacion.md` _(pendiente)_
