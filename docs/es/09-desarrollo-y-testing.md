# Desarrollo y testing

Esta guía explica cómo preparar el proyecto localmente, qué comandos usar y cómo pensar los tests de `opencode-subagent-statusline`.

La regla práctica:

> El núcleo determinístico se prueba con Vitest. La UI completa dentro del host OpenCode/OpenTUI se valida con smoke tests manuales cuando hay cambios visuales.

## Requisitos

El paquete requiere Node.js 24 o más reciente. Usá la versión de pnpm declarada en `package.json` y respetá el lockfile.

## Instalación local

Desde la raíz del repo:

```sh
pnpm install
```

## Comandos principales

| Comando               | Para qué sirve                           |
| --------------------- | ---------------------------------------- |
| `pnpm build`          | Compila el paquete con `tsup`.           |
| `pnpm dev`            | Corre `tsup --watch`.                    |
| `pnpm typecheck`      | Ejecuta TypeScript sin emitir archivos.  |
| `pnpm test`           | Corre la suite Vitest una vez.           |
| `pnpm test:watch`     | Corre Vitest en modo watch.              |
| `pnpm test:coverage`  | Genera cobertura con V8.                 |
| `pnpm pack --dry-run` | Simula el paquete npm que se publicaría. |

Checklist recomendado antes de abrir PR:

```sh
pnpm typecheck
pnpm test
pnpm build
```

Si tocaste packaging o archivos publicados:

```sh
pnpm pack --dry-run
```

## Build

El build usa `tsup.config.ts` y genera un único bundle TUI:

| Fuente | Salida | Uso |
| --- | --- | --- |
| `src/tui.tsx` | `dist/tui.js` + `dist/tui.d.ts` | Plugin TUI soportado. |

Los dos entrypoints soportados resuelven esa misma salida TUI:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
```

## TypeScript

Archivos relevantes:

| Archivo              | Rol                                                                               |
| -------------------- | --------------------------------------------------------------------------------- |
| `tsconfig.json`      | Config base del source. Usa NodeNext, ES2022, strict y JSX para `@opentui/solid`. |
| `tsconfig.test.json` | Config para tests, Vitest y archivos de setup.                                    |
| `tsup.config.ts`     | Config del único build TUI.                                                       |

## Estrategia de tests

El proyecto usa Vitest para unit tests determinísticos y seams focalizados de integración TUI. Los tests puros de proyección, descubrimiento de descendientes y filas del árbol cubren el comportamiento anidado sin iniciar un host OpenCode completo.

La referencia actual de la suite completa es de 351 tests aprobados en 17 archivos.

La UI visual completa se deja fuera de E2E profundo por ahora para evitar tests frágiles contra el host.

## Mapa de tests

| Archivo                           | Qué valida                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `src/events.test.ts`              | Parsing de eventos, extracción de IDs, correlación y tolerancia a payloads malformados. |
| `src/state.test.ts`               | Estado, contadores, transiciones, poda, persistencia y normalización.                   |
| `src/render.test.ts`              | Render textual, collapse, visibilidad, duración, tokens y color/no-color.               |
| `src/reconcile.test.ts`           | Normalización de estados, stale-running, backoff y fail-closed.                         |
| `src/text-width.test.ts`          | Ancho de columnas para texto CJK/full-width, marcas combinantes y truncado.              |
| `src/projection.test.ts`          | Proyección pura a toda profundidad, orden padre-hijo, correlación, contadores y ciclos. |
| `src/tui-descendant-hydration.test.ts` | Descubrimiento iterativo acotado, cancelación, filtrado fail-closed y batch único. |
| `src/tui-tree-row.test.ts`        | Indentación pura, ajuste en ancho estrecho, labels y navegación anidada.                |
| `src/tui.test.ts`                 | Ciclo de vida TUI, persistencia, comandos, `Alt+B`, keybindings y seams de integración. |
| `src/persistence.test.ts`         | Coordinación de persistencia, coalescing, flush y conservación de metadata.             |
| `test/helpers/test-harness.ts`    | Helpers para temp dirs aislados, fixtures, filesystem y fake time.                      |
| `test/setup.ts`                   | Limpieza global de timers, mocks, env vars y temp dirs.                                 |
| `test/package-contract.test.ts`   | Exports raíz y `/tui`, y ausencia de source y artefactos eliminados.                    |

## Coverage

La cobertura se configura en `vitest.config.ts`:

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "lcov"],
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.test.ts", "src/tui.tsx"],
}
```

Punto importante:

> `src/tui.tsx` está excluido de coverage. No digas que la TUI visual completa está cubierta por tests automáticos.

La cobertura actual se enfoca en módulos `.ts` determinísticos: eventos, estado, proyección, render, reconcile, helpers de ancho textual, comandos, descubrimiento y filas del árbol.

## Patrón Arrange / Act / Assert

Los tests deberían seguir esta estructura:

```ts
it("renders an empty summary", () => {
  // Arrange
  const state = createEmptyState();

  // Act
  const output = renderStatusline(state);

  // Assert
  expect(output).toContain("0 running");
  expect(output).toContain("0 done");
});
```

Preferí asserts semánticos antes que snapshots grandes.

Bueno:

```ts
expect(output).toContain("1 running");
expect(output).toContain("Review auth changes");
```

Más frágil:

```ts
expect(output).toMatchSnapshot();
```

## Cómo agregar un unit test

1. Identificá el comportamiento a proteger.
2. Elegí el archivo co-localizado:
   - `src/events.test.ts`
   - `src/state.test.ts`
   - `src/render.test.ts`
   - `src/reconcile.test.ts`
   - `src/tui.test.ts`
3. Armá inputs mínimos.
4. Ejecutá la función pública o helper bajo test.
5. Afirmá comportamiento visible, no detalles accidentales.

Ejemplo conceptual:

```ts
it("does not count tool wrappers", () => {
  const state = createEmptyState();

  upsertRunningChild(state, {
    id: "tool:prt_1",
    source: "tool",
  });

  expect(state.totalExecuted).toBe(0);
});
```

## Cómo agregar un test aislado de filesystem

Usá `test/helpers/test-harness.ts` cuando un test de estado o persistencia necesite filesystem y variables de entorno aislados:

```ts
it("writes an isolated state snapshot", async () => {
  const harness = await createFileHarness();
  const state = createEmptyState();

  await saveState(harness.statePath, state);

  expect(await pathExists(harness.statePath)).toBe(true);
});
```

Helpers útiles:

| Helper                   | Uso                                                 |
| ------------------------ | --------------------------------------------------- |
| `createFileHarness()`    | Crea un temp dir y rutas aisladas de estado y texto. |
| `readJsonFixture(name)`  | Lee fixtures de `test/fixtures/events/<name>.json`. |
| `pathExists(path)`       | Verifica existencia sin throw.                      |
| `useFrozenTime(iso)`     | Congela tiempo con fake timers.                     |

## Fixtures

Los fixtures viven en:

```txt
test/fixtures/events/
```

Usalos cuando un payload se reutiliza o cuando conviene documentar una forma conocida de evento OpenCode.

Mantenelos chicos y representativos. No metas dumps enormes salvo que el tamaño sea parte del comportamiento a proteger.

## Fake timers

Si un test depende del tiempo:

- congelá explícitamente el tiempo en Arrange;
- evitá estado global compartido;
- dejá que `test/setup.ts` restaure timers reales después del test.

Ejemplo:

```ts
useFrozenTime("2026-01-01T00:00:00.000Z");
```

## Variables de entorno en tests

`test/setup.ts` restaura env vars del plugin después de cada test.

Si agregás una nueva variable que los tests modifican, agregala a la lista de cleanup en `test/setup.ts`.

## Qué no testear todavía

No agregues todavía automatización profunda para:

- snapshots visuales completos de OpenTUI;
- navegación host-driven completa dentro de OpenCode;
- E2E amplio de `src/tui.tsx`.

Para cambios de UI real, preferí:

1. tests unitarios para lógica extraíble;
2. tests de comandos si cambia keybinding/registro;
3. smoke test manual en OpenCode.

## Smoke test manual TUI

Cuando tocás `src/tui.tsx`, `src/render.ts` o comportamiento visible:

1. Compilá:

   ```sh
   pnpm build
   ```

2. Configurá OpenCode con ruta absoluta:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["/absolute/path/to/sub-agent-statusline/dist/tui.js"]
   }
   ```

3. Reiniciá OpenCode.
4. Ejecutá una delegación/subagente.
5. Verificá descendientes en todas las profundidades, orden padre-hijo, estados y duración.
6. Probá `Alt+B`, `j/k`, flechas, `Enter` y `Esc`.
7. Si hay tokens/contexto, confirmá que se muestran sin romper la fila.
8. Revisá logs si el plugin no carga.

## CI

El workflow de PR está en `.github/workflows/ci.yml`.

Corre:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

No corre `pnpm build` ni `pnpm pack --dry-run`.

Por eso, si tu cambio toca build, package exports, assets publicados o `package.json.files`, corré esos comandos manualmente.

## Buenas prácticas de contribución

Según `CONTRIBUTING.md`:

- preferí issue-first para cambios no triviales;
- mantené PRs chicos y revisables;
- usá Conventional Commits;
- nunca commitees secretos;
- explicá qué cambió, por qué y cómo lo validaste.

Ejemplos de commits:

```txt
feat: add nested session rows
fix: handle missing token metadata
docs: clarify local setup
```

## Checklist rápido por tipo de cambio

| Cambio                | Validación mínima recomendada                |
| --------------------- | -------------------------------------------- |
| Solo docs             | Revisar links y formato Markdown.            |
| Eventos/estado/render | `pnpm test`, tests focalizados.              |
| TypeScript/API        | `pnpm typecheck`, `pnpm test`.               |
| TUI visual            | `pnpm build`, smoke test manual en OpenCode. |
| Packaging             | `pnpm build`, `pnpm pack --dry-run`.         |
| CI/release            | Revisar workflows y documentar impacto.      |
