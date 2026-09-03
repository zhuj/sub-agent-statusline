# Visión general

`opencode-subagent-statusline` es un plugin TUI para OpenCode que muestra actividad de subagentes dentro de la interfaz: subagentes corriendo, finalizados, fallidos, duración y uso de tokens/contexto cuando OpenCode expone esa información.

La idea central es simple:

> Cuando delegás trabajo a subagentes, el plugin mantiene visible qué está pasando sin obligarte a reconstruirlo desde eventos, logs o sesiones hijas.

## Qué problema resuelve

OpenCode puede ejecutar trabajo delegado en sesiones hijas o a través de herramientas como `task` y `delegate`. Eso es útil, pero genera una dificultad práctica: la actividad puede quedar repartida entre eventos de sesión, partes de mensajes y wrappers técnicos.

Sin una vista dedicada, es fácil perder respuestas a preguntas como:

- ¿Hay un subagente todavía corriendo?
- ¿Terminó bien o falló?
- ¿Cuál fue la sesión hija real?
- ¿Cuánto tiempo lleva?
- ¿Cuánto contexto usó?
- ¿Estoy viendo trabajo real o un wrapper técnico duplicado?

Este plugin junta esas señales y las convierte en una vista compacta para la TUI.

## Qué muestra

En la TUI, el plugin puede mostrar:

- subagentes en ejecución;
- subagentes terminados recientemente;
- subagentes con error;
- duración estimada;
- tokens y porcentaje de contexto cuando están disponibles;
- resumen agregado en la pantalla de inicio;
- navegación hacia la sesión hija real cuando existe un `sessionID` navegable.

La TUI hidrata tokens/contexto desde el estado vivo en memoria y los eventos, junto con `session.messages`. Los snapshots persistidos, la base de datos local de OpenCode y los archivos de log recientes no son fuentes de recuperación.

## Entrypoints públicos

El paquete soporta estos dos entrypoints TUI:

| Entrypoint | Fuente | Uso principal |
| --- | --- | --- |
| `opencode-subagent-statusline` | `src/tui.tsx` | Plugin TUI principal. Es el camino recomendado para usuarios. |
| `opencode-subagent-statusline/tui` | `src/tui.tsx` | Alias explícito del mismo plugin TUI. |

Ambos entrypoints cargan el mismo plugin TUI soportado.

## Cómo funciona a alto nivel

El flujo general es este:

```txt
OpenCode event
  -> src/events.ts
  -> src/state.ts
  -> src/projection.ts
  -> src/render.ts
  -> src/tui.tsx
  -> sidebar / home footer / status.txt
```

Paso por paso:

1. **OpenCode emite eventos**
   - Por ejemplo: `session.created`, `session.status`, `message.part.updated`.

2. **El plugin extrae evidencia de subagentes**
   - `src/events.ts` interpreta eventos de sesión, subtareas y herramientas.

3. **El estado interno se actualiza**
   - `src/state.ts` guarda hijos, estados, tiempos, tokens y contadores.

4. **El render decide qué se ve**
   - `src/render.ts` colapsa duplicados, filtra filas antiguas y arma textos agregados.

5. **La TUI muestra la información**
   - `src/tui.tsx` registra slots, comandos, navegación, hidratación y reconciliación.

## Concepto clave: no todo evento es una ejecución real

Este es el punto más importante para entender el proyecto.

OpenCode puede representar el trabajo delegado de varias formas:

| Source interno | Qué representa                                            | Cuenta como ejecución          |
| -------------- | --------------------------------------------------------- | ------------------------------ |
| `session`      | Una sesión hija real de OpenCode.                         | Sí, una vez. |
| `subtask`      | Una subtarea sintética derivada de partes de mensaje.     | No. Puede correlacionarse con una sesión real posterior. |
| `tool`         | Wrapper técnico de herramientas como `task` o `delegate`. | No. |

Por eso el plugin separa tres cosas:

1. **Estado almacenado**: todo lo que sabe el plugin.
2. **Filas visibles**: lo que conviene mostrar después de colapsar duplicados.
3. **Total ejecutado**: el conteo semántico de trabajo real.

Una fila visible no siempre equivale a una ejecución. Las filas sintéticas `subtask:*` y `tool:*` pueden aportar evidencia de visualización, estado, correlación o navegación, pero nunca entran en `countedChildIDs` ni incrementan `totalExecuted`. Solo cuenta una sesión real `ses_*` observada, una vez.

## Diseño defensivo

El plugin trabaja contra eventos que pueden variar según la versión de OpenCode, el tipo de delegación y el momento en que llega la información.

Por eso varias partes del diseño son conservadoras:

- si una correlación es ambigua, no se fuerza;
- si aparecen múltiples IDs posibles, no se adivina;
- si una sesión parece vieja pero no hay evidencia segura, no se cierra a ciegas;
- si falta información de tokens/contexto, se omite sin romper la UI;
- si falla una escritura auxiliar de estado/debug, el plugin intenta no romper OpenCode.

Esta estrategia aparece varias veces en el código y en los tests como comportamiento **fail-closed**.

## Qué está probado

El núcleo determinístico tiene buena cobertura de tests:

- parsing de eventos;
- transiciones de estado;
- contadores y deduplicación;
- render textual;
- reconciliación conservadora;
- proyección, descubrimiento y filas de árbol a toda profundidad;
- comandos, keybindings y persistencia propia de la TUI.

El límite actual es la UI visual completa dentro del host OpenCode/OpenTUI: no hay automatización E2E profunda de la TUI. Para cambios visuales, el proyecto recomienda smoke tests manuales además de los tests automatizados.

## Dónde seguir

Para entender el código, seguí con:

- [Arquitectura](./03-arquitectura.md)
- `04-flujo-de-eventos.md` _(pendiente)_
- `05-modelo-de-estado-y-contadores.md` _(pendiente)_
- `06-renderizado-y-deduplicacion.md` _(pendiente)_
