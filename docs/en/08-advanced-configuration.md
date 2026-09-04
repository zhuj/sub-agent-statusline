# Advanced configuration

Normal plugin configuration is minimal: add it to OpenCode's `tui.json`. This page documents advanced options for development and diagnostics.

If you only want to use the plugin, you probably do not need to change anything here.

## Basic TUI configuration

Usual file:

```txt
~/.config/opencode/tui.json
```

Minimal content:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-subagent-statusline"]
}
```

Local development:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/sub-agent-statusline/dist/tui.js"]
}
```

## Environment variables

These variables are advanced diagnostic controls. They are not stable public API
for 1.x, except where the README describes user-facing privacy behavior.

| Variable | Use | When to touch it |
| --- | --- | --- |
| `OPENCODE_SUBAGENT_STATUSLINE_COLOR=0` | Disables ANSI colors in text rendering. | Logs or no-color terminals. |
| `NO_COLOR=1` | Standard no-color switch. | CI/log environments. |

The plugin is in-memory only and does not write a state file, status file, or
debug log; nothing else in the environment is read for state, instance, or
file-path configuration.

## Color

Disable ANSI colors in text output:

```sh
NO_COLOR=1 opencode
```

or:

```sh
OPENCODE_SUBAGENT_STATUSLINE_COLOR=0 opencode
```

This affects text rendering in the home summary, not necessarily the visual
OpenTUI rendering, which is themed by OpenCode.

## Stale-running threshold

Default stale-running threshold is long and conservative: about 10 hours.

Override it with:

```sh
OPENCODE_SUBAGENT_STATUSLINE_STALE_RUNNING_MS=3600000 opencode
```

This sets 1 hour. Avoid aggressive values except for diagnostics.

## OpenCode package cache

OpenCode can cache packages.

If a new version was installed but OpenCode still uses an old one, clear:

```txt
~/.cache/opencode/packages/
```

Then restart OpenCode.

## Logs

Check loading problems with:

```sh
grep -n "subagent-statusline\|failed to load tui plugin" ~/.local/share/opencode/log/*.log
```

Look for package resolution, invalid entrypoint, local build, absolute path, or peer dependency errors.

## Peer dependencies

The package declares peers for OpenCode/OpenTUI/Solid:

- `@opencode-ai/plugin`
- `@opentui/core`
- `@opentui/solid`
- `solid-js`

The TUI build externalizes these dependencies. Some issues can therefore depend on the OpenCode host version rather than only plugin code.

## Docs and npm package

`docs/en/` and `docs/es/` are currently repository-facing docs.

With the current `package.json`, npm publishes:

```txt
dist
assets
README.md
```

If docs should ship in the npm package later:

1. add `docs` or specific docs folders to `package.json.files`;
2. run:

   ```sh
   pnpm pack --dry-run
   ```

3. verify the included files.

## Diagnostic checklist

1. Confirm OpenCode loads the expected plugin.
2. Check OpenCode logs.
3. If using a local path, run `pnpm build`.
4. Confirm `tui.json` uses the package name or an absolute `dist/tui.js` path.
5. Clear package cache if an old version appears.
6. Do not assume token/context data will always be available.

## Related files

| File | What to inspect |
| --- | --- |
| `src/state.ts` | Data model, counters, and mutation helpers. |
| `src/tui.tsx` | Slot registration, hydration, and stale-threshold handling. |
| `src/events.ts` | OpenCode event parsing. |
| `src/render.ts` | Color and text rendering. |
| `package.json` | Exports, published files, and peer dependencies. |
| `README.md` | Basic installation and troubleshooting. |
