# Configuración avanzada

La configuración normal del plugin es mínima: agregarlo al `tui.json` de OpenCode. Esta página documenta opciones avanzadas para desarrollo TUI, persistencia y diagnóstico.

Si solo querés usar el plugin, probablemente no necesitás tocar nada de esto.

## Configuración TUI básica

Archivo usual:

```txt
~/.config/opencode/tui.json
```

Contenido mínimo:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-subagent-statusline"]
}
```

El paquete soporta dos nombres para el mismo plugin TUI:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
```

Para desarrollo local:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/sub-agent-statusline/dist/tui.js"]
}
```

## Variables de entorno

| Variable                                        | Uso                                                 | Cuándo tocarla                         |
| ----------------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| `OPENCODE_SUBAGENT_STATUSLINE_STATE`            | Sobrescribe la ruta TUI de `state.json`.            | Tests, debugging o una ruta local propia. |
| `OPENCODE_SUBAGENT_STATUSLINE_INSTANCE`         | Define el nombre de instancia para rutas de estado. | Evitar colisiones entre procesos.      |
| `OPENCODE_SUBAGENT_STATUSLINE_COLOR=0`          | Desactiva ANSI colors en render textual.            | Logs o terminales sin color.           |
| `NO_COLOR=1`                                    | Desactiva color ANSI de forma estándar.             | Entornos CI/logs.                      |
| `OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS`     | Activa log JSONL de eventos TUI.                    | Investigar payloads de OpenCode.       |
| `OPENCODE_SUBAGENT_STATUSLINE_STALE_RUNNING_MS` | Cambia umbral para stale-running.                   | Diagnóstico de filas `running` viejas. |
| `XDG_RUNTIME_DIR`                               | Base por defecto para archivos locales de la TUI.   | Entornos Linux/custom.                 |

## Rutas de estado

Por defecto, el estado de la TUI se guarda bajo:

```txt
$XDG_RUNTIME_DIR/opencode-subagent-statusline/<instance>/state.json
```

Si `XDG_RUNTIME_DIR` no existe, se usa el tempdir del sistema.

Junto a `state.json`, la TUI escribe:

```txt
status.txt
```

`status.txt` contiene el render textual del estado actual.

## Instance name

La instancia por defecto suele basarse en el PID del proceso:

```txt
pid-<process.pid>
```

Podés sobrescribirla:

```sh
OPENCODE_SUBAGENT_STATUSLINE_INSTANCE=debug-1 opencode
```

Esto sirve cuando querés separar archivos de estado entre varias ejecuciones.

## State path custom

Para forzar una ruta concreta:

```sh
OPENCODE_SUBAGENT_STATUSLINE_STATE=/tmp/subagent-statusline/state.json opencode
```

Esto es especialmente útil en tests o reproducciones.

## Color

Para desactivar colores ANSI en el render textual:

```sh
NO_COLOR=1 opencode
```

O:

```sh
OPENCODE_SUBAGENT_STATUSLINE_COLOR=0 opencode
```

Esto afecta salidas textuales como `status.txt`, no necesariamente el render visual propio de OpenTUI.

## Debug de eventos TUI

Para investigar payloads que OpenCode está emitiendo:

```sh
OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS=1 opencode
```

El plugin escribe un log JSONL bajo una ruta temporal del estilo:

```txt
$XDG_RUNTIME_DIR/opencode-subagent-statusline/tui-events.log
```

O, si no hay `XDG_RUNTIME_DIR`, bajo el tempdir del sistema.

Usalo con cuidado: los eventos pueden contener bastante información y crecer rápido.

## Hidratación de tokens/contexto

La TUI hidrata tokens/contexto únicamente desde el estado actual de OpenCode TUI
y la API `session.messages`. No recupera evidencia de tokens desde la base de
datos local de OpenCode, `state.json`, `status.txt` ni archivos de log. Si
OpenCode no expone datos de tokens, la fila sigue visible sin esos detalles.

## Stale-running threshold

Los subagentes pueden quedar `running` si falta evidencia terminal.

El umbral por defecto es largo y conservador: aproximadamente 10 horas.

Para cambiarlo:

```sh
OPENCODE_SUBAGENT_STATUSLINE_STALE_RUNNING_MS=3600000 opencode
```

Eso define 1 hora.

No conviene usar valores agresivos salvo para diagnóstico. Un umbral muy bajo puede cerrar filas que todavía están activas si la evidencia no llegó a tiempo.

## Cache de paquetes de OpenCode

OpenCode puede cachear paquetes instalados.

Si instalaste una versión nueva y OpenCode sigue usando una anterior, probá limpiar:

```txt
~/.cache/opencode/packages/
```

Después reiniciá OpenCode.

## Logs de OpenCode

Para revisar problemas de carga:

```sh
grep -n "subagent-statusline\|failed to load tui plugin" ~/.local/share/opencode/log/*.log
```

Buscá errores de:

- paquete no encontrado;
- entrypoint inválido;
- fallo de build local;
- ruta absoluta incorrecta;
- dependencia peer no disponible en el host.

## Peer dependencies

El paquete declara peers relacionados con OpenCode/OpenTUI/Solid:

- `@opencode-ai/plugin`
- `@opentui/core`
- `@opentui/solid`
- `solid-js`

El build TUI externaliza estas dependencias. En uso normal, el host OpenCode/cache resuelve el entorno.

Esto significa que algunos problemas pueden depender de la versión de OpenCode más que del código del plugin.

## Docs y npm package

La documentación en `docs/es/` está pensada primero para lectores del repo.

Con la configuración actual de `package.json`, el paquete npm publica:

```txt
dist
assets
README.md
```

Eso significa que `docs/es/` no se incluiría en npm salvo que se actualice la lista `files`.

Si en el futuro se quiere publicar esta documentación dentro del paquete, habría que:

1. agregar `docs` o `docs/es` a `package.json.files`;
2. correr:

   ```sh
   pnpm pack --dry-run
   ```

3. verificar que el contenido incluido sea el esperado.

## Checklist de diagnóstico

Cuando algo no funciona:

1. Confirmá que OpenCode carga el plugin correcto.
2. Revisá logs de OpenCode.
3. Si usás ruta local, corré `pnpm build`.
4. Confirmá que `tui.json` usa una ruta absoluta o el nombre del paquete.
5. Limpiá cache de paquetes si hay una versión vieja.
6. Activá `OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS` si necesitás ver payloads.
7. Revisá `state.json`, `status.txt` o `tui-events.log` de la TUI para diagnosticar salidas locales.
8. No asumas que tokens/contexto siempre estarán disponibles.

## Archivos relacionados

| Archivo         | Qué mirar                                                |
| --------------- | -------------------------------------------------------- |
| `src/state.ts`  | Resolución de rutas, persistencia y variables de estado. |
| `src/tui.tsx`   | Eventos de debug, hidratación por API, persistencia y stale threshold. |
| `src/render.ts` | Color y render textual.                                  |
| `package.json`  | Exports, files publicados y peer dependencies.           |
| `README.md`     | Instalación y troubleshooting básico.                    |
