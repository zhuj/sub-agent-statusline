# Configuración avanzada

La configuración normal del plugin es mínima: agregarlo al `tui.json` de OpenCode. Esta página documenta opciones avanzadas para desarrollo y diagnóstico.

Si solo querés usar el plugin, probablemente no necesites cambiar nada acá.

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

Desarrollo local:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/sub-agent-statusline/dist/tui.js"]
}
```

## Variables de entorno

Estas variables son controles de diagnóstico avanzado. No son API pública
estable para 1.x, salvo donde el README describe el comportamiento de
privacidad para el usuario.

| Variable | Uso | Cuándo tocarla |
| --- | --- | --- |
| `OPENCODE_SUBAGENT_STATUSLINE_COLOR=0` | Deshabilita colores ANSI en el render textual. | Logs o terminales sin color. |
| `NO_COLOR=1` | Switch estándar sin color. | Entornos de CI/logs. |

El plugin es solo en memoria y no escribe state file, status file ni debug
log; nada más del entorno se lee para configuración de estado, instancia o
rutas de archivos.

## Color

Deshabilitar colores ANSI en el texto:

```sh
NO_COLOR=1 opencode
```

o:

```sh
OPENCODE_SUBAGENT_STATUSLINE_COLOR=0 opencode
```

Esto afecta el render textual del resumen de home, no necesariamente el
render visual de OpenTUI, que es tematizado por OpenCode.

## Umbral de `running` viejo

El umbral por defecto es largo y conservador: cerca de 10 horas.

Sobrescribirlo con:

```sh
OPENCODE_SUBAGENT_STATUSLINE_STALE_RUNNING_MS=3600000 opencode
```

Esto fija 1 hora. Evitá valores agresivos salvo para diagnóstico.

## Caché de paquetes de OpenCode

OpenCode puede cachear paquetes.

Si instalaste una versión nueva pero OpenCode sigue usando la anterior, limpiá:

```txt
~/.cache/opencode/packages/
```

Después, reiniciá OpenCode.

## Logs

Para chequear problemas de carga:

```sh
grep -n "subagent-statusline\|failed to load tui plugin" ~/.local/share/opencode/log/*.log
```

Buscá errores de resolución del paquete, entrypoint inválido, build local, ruta absoluta o dependencias peer.

## Dependencias peer

El paquete declara peers para OpenCode/OpenTUI/Solid:

- `@opencode-ai/plugin`
- `@opentui/core`
- `@opentui/solid`
- `solid-js`

El build de la TUI externaliza esas dependencias. Algunos problemas pueden depender entonces de la versión del host de OpenCode, no solo del código del plugin.

## Documentación y paquete npm

`docs/en/` y `docs/es/` son docs orientadas al repositorio.

Con el `package.json` actual, npm publica:

```txt
dist
assets
README.md
```

Si en el futuro se quieren incluir los docs en el paquete:

1. agregar `docs` o carpetas específicas en `package.json.files`;
2. correr:

   ```sh
   pnpm pack --dry-run
   ```

3. verificar los archivos incluidos.

## Checklist de diagnóstico

1. Confirmar que OpenCode cargó el plugin esperado.
2. Revisar los logs de OpenCode.
3. Si usás una ruta local, correr `pnpm build`.
4. Confirmar que `tui.json` use el nombre del paquete o una ruta absoluta a `dist/tui.js`.
5. Limpiar la caché de paquetes si aparece una versión vieja.
6. No asumir que los datos de token/context estarán siempre disponibles.

## Archivos relacionados

| Archivo | Qué inspeccionar |
| --- | --- |
| `src/state.ts` | Modelo de datos, contadores y mutaciones. |
| `src/tui.tsx` | Registro de slots, hidratación y umbral de stale-running. |
| `src/events.ts` | Parsing de eventos de OpenCode. |
| `src/render.ts` | Color y render textual. |
| `package.json` | Exports, archivos publicados y peer dependencies. |
| `README.md` | Instalación básica y troubleshooting. |
