# Plugin Communication: TUI ↔ Server in OpenCode

A complete guide to how plugin code on the TUI side talks to plugin code on the server side, and back, using channels that already exist in the codebase. Every example compiles against the current `@opencode-ai/plugin`, `@opencode-ai/sdk`, and `@opencode-ai/plugin/tui` types.

## 1. Process topology

Three runtimes. They communicate over well-defined boundaries — there is no shared heap, no shared module state, and no shared types beyond the SDK and the `tui.*` event schemas.

```
+----------------------+        +-------------------------+        +----------------------+
|  TUI process         |        |  Worker process         |        |  Server process      |
|  (packages/tui)      |        |  (cli/tui/worker.ts)    |        |  (server/server.ts)  |
|                      |        |                         |        |                      |
|  Solid app           |  RPC   |  Server, Plugins,       |  HTTP  |  Only when --port/   |
|  TUI plugins         | <----> |  EventV2, GlobalBus,    | <----> |  --hostname/--mdns   |
|  (api.client)        |  emit  |  SDK + server plugins   |  req   |  is set. Default:    |
|  (api.event)         | -----> |  (input.client)         |        |  worker IS the       |
|                      |        |                         |        |  server.             |
+----------------------+        +-------------------------+        +----------------------+
```

- **TUI process** hosts your TUI-side plugin code. It runs the OpenTUI/Solid renderer and has its own JS heap.
- **Worker process** is a `new Worker(...)` started by the CLI command thread (`packages/opencode/src/cli/cmd/tui.ts`). It hosts the `Server`, the `InstanceRuntime`, all server plugins, and forwards every `GlobalBus` event over `Rpc.emit("global.event", event)` to the CLI thread (see `packages/opencode/src/cli/tui/worker.ts:23-26`).
- **Server process** only exists when `--port`, `--hostname`, or `--mdns` is passed. Same handlers, just listening on a real socket.

By default there are only **two** processes (TUI + worker). The worker fulfills every request itself. Plugins are not in a third process; they live in whichever runtime they are loaded into.

### What runs where

| Runtime | Plugin code | Lifetime |
|---|---|---|
| Worker | `PluginModule.server` (`input: PluginInput`) | One instance per `InstanceState` (per directory). Disposed when the instance is disposed. |
| TUI | `TuiPluginModule.tui` (`(api, options, meta) => Promise<void>`) | Re-evaluated on plugin reload. `meta.state` tells you if it's `"first" \| "updated" \| "same"`. |
| Server (external) | Same as worker | Same. |

You can ship **one package** that contains both halves and registers them via `PluginModule` in the same module — see section 9.

## 2. The two transports

`cli/cmd/tui.ts:238-249` selects the transport:

```ts
const transport = external
  ? {
      url: (await client.call("server", network)).url,
      fetch: undefined,
      events: undefined,
      headers,
    }
  : {
      url: "http://opencode.internal",
      fetch: createWorkerFetch(client),  // forwards every fetch to the worker via RPC
      events: createEventSource(client), // subscribes to "global.event" from the worker
    }
```

Plugins never pick the transport — the SDK does. `api.client` always uses the right one.

## 3. Channel matrix

There are exactly four channels a plugin author can use today. Pick by *what you need the data to mean*, not by which side of the wire you're on.

| # | Direction | Mechanism | What travels on it | Where to read about it |
|---|---|---|---|---|
| 1 | TUI → Server | `api.client.*` (OpencodeClient) | HTTP request/response | §4 |
| 2 | Server → TUI | `global.event` SSE stream | Any `Event["type"]` payload | §5 |
| 3 | Server → TUI | `tui.*` targeted events | Toasts, command dispatch, prompt append, session select | §6 |
| 4 | Bidirectional (through the agent) | Custom tool + tool parts | LLM-driven call/result | §7 |

Plus two derived patterns:

| # | Pattern | Use when |
|---|---|---|
| 5 | Custom event type on `global.event` for a TUI↔Server pair | You have a private RPC the SDK doesn't model (§8) |
| 6 | Slot/route/dialog/toast inside the TUI process | You only need to extend the TUI itself — no server round-trip |

The only cross-process pattern that *isn't* REST or SSE today is #5. Everything else you can do with the channels above.

## 4. TUI → Server: `api.client`

Both halves get the same `OpencodeClient` instance, configured with the right base URL, fetch, and `directory` header.

```ts
// TUI plugin
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  // The full SDK is the same as what a remote CLI or web UI would call.
  const sessions = await api.client.session.list({})
  const session = await api.client.session.create({ title: "From TUI" })
  await api.client.session.chat(session.id, {
    parts: [{ type: "text", text: "Hello from a TUI plugin" }],
  })

  // Streamed responses — the SDK exposes a `.stream()` variant on POST methods
  // for endpoints that return a stream.
  const stream = await api.client.event.list({ directory: api.tuiConfig.directory })
  // stream is a ReadableStream of SSE.
}
```

From the server side you do exactly the same thing — the SDK is identical.

```ts
// Server plugin
import type { Plugin } from "@opencode-ai/plugin"

const server: Plugin = async (input) => {
  const sessions = await input.client.session.list({})
  const created = await input.client.session.create({ title: "From server plugin" })
  return {}
}
```

The only constraint: `api.client` is **the same SDK** as `input.client`. So whatever an external caller can do, your plugin can do. There's no "second-class" transport for plugins.

### Gotchas

- **`directory` header**: the SDK sets it from `tuiConfig.directory` / `input.directory` automatically. If you call `createOpencodeClient` yourself, supply it manually.
- **Abort**: tie long-running requests to `api.lifecycle.signal` so they cancel on plugin dispose. The TUI side gives you an `AbortSignal` directly; the server side uses the Effect runtime, so the request just completes (no equivalent AbortSignal is exposed on `input`).
- **Reactivity**: the TUI's `useSDK()` batches `global.event` in 16 ms windows (`packages/tui/src/context/sdk.tsx`). Reads from `api.client` are *not* reactive — you need to use `api.state` for live snapshots, or `api.event.on(...)` for change notifications.

## 5. Server → TUI: `global.event`

A single shared event bus flowing server → TUI. Every event published by `EventV2` is re-emitted on `GlobalBus` (via `EventV2Bridge`), forwarded to the CLI thread over `Rpc.emit("global.event", event)`, and consumed by the TUI's `useSDK` Solid emitter.

A TUI plugin subscribes via `api.event`:

```ts
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  // Typed — `type` must be a known Event["type"] literal.
  const off = api.event.on("session.updated", (event) => {
    // event.properties has the session info
    if (event.properties.id === "ses_watched") {
      api.ui.toast({
        title: "Session updated",
        message: event.properties.title ?? "",
        variant: "info",
        duration: 5000,
      })
    }
  })
  api.lifecycle.onDispose(off)
}
```

The full list of event types is the `Event` union in `packages/schema/src/event.ts` — you can browse the auto-generated SDK to see them.

### What the payload looks like

Every event on the bus has the shape from `packages/opencode/src/bus/global.ts`:

```ts
type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any  // EventV2's payload — has a `type` discriminator
}
```

TUI plugins get a more specific view (the typed `event` callback), but on the wire it's a flat object with `directory`, `project`, `workspace`, and `payload`.

### Where to publish

On the server, you publish by writing to `GlobalBus`:

```ts
import { GlobalBus } from "@/bus/global"  // internal — not exposed to plugins
```

Plugins do not import `@/bus/global` directly. Instead, **server plugins publish through `input.client.event.subscribe()` callbacks or custom tools** — but the cleanest way to publish a custom event is to emit a `tui.*` event (see §6) or use the `experimental.text.complete` / `experimental.session.compacting` hooks that already flow through `EventV2`.

For a custom event type from a server plugin, the standard pattern is to **register a tool** that, when called by the LLM, has the side effect of emitting a `global.event`. The event then lands in every TUI's `api.event.on(...)` listeners (filtered by `directory` in the bridge).

## 6. Server → TUI targeted: `tui.*` events

A small set of pre-defined events that skip the broadcast fan-out and go directly to a specific TUI instance. The schemas live in `packages/schema/src/tui-event.ts`:

| Event | Payload | Effect in TUI |
|---|---|---|
| `tui.toast.show` | `{ title?, message, variant: "info" \| "success" \| "warning" \| "error", duration: number }` | Shows a toast |
| `tui.command.execute` | `{ command: string }` | Dispatches the command via `keymap.dispatchCommand(command)` |
| `tui.prompt.append` | `{ text }` | Appends to the prompt input |
| `tui.session.select` | `{ sessionID }` | Navigates to that session |

The TUI consumer is in `packages/tui/src/app.tsx:985-1006`:

```ts
event.on("tui.command.execute", (evt, { workspace }) => {
  if (workspace !== project.workspace.current()) return
  keymap.dispatchCommand(evt.properties.command)
})

event.on("tui.toast.show", (evt, { workspace }) => {
  if (workspace !== project.workspace.current()) return
  toast.show({
    title: evt.properties.title,
    message: evt.properties.message,
    variant: evt.properties.variant,
    duration: evt.properties.duration,
  })
})

event.on("tui.session.select", (evt, { workspace }) => {
  if (workspace !== project.workspace.current()) return
  route.navigate({ type: "session", sessionID: evt.properties.sessionID })
})
```

Workspace filter is automatic — if the TUI is showing a different workspace, the event is ignored.

### How to publish `tui.*` events from a server plugin

The HTTP group is `tui` (`packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts`). The `/tui/publish` endpoint accepts any of the four event types. A server plugin calls it via the SDK once it has an SDK method — but today there is no generated SDK method for `tui.publish` directly.

The cleanest path from a server plugin:

```ts
import type { Plugin } from "@opencode-ai/plugin"

const server: Plugin = async (input) => {
  // Option 1: use a generic event publishing route (when present)
  // input.client.post("/tui/publish", { type: "tui.toast.show", properties: { ... } })

  // Option 2: register a custom tool that the LLM calls when it wants to notify the user.
  // The tool's side effect posts to the tui/publish endpoint. See §7.
  return {
    tool: {
      "notify_user": notifyUserTool(input),
    },
  }
}
```

### Reading `tui.*` events from a TUI plugin

You can subscribe to them with the typed event bus:

```ts
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  // The typed bus accepts any Event["type"]; "tui.toast.show" is in the Event inventory.
  const off = api.event.on("tui.toast.show", (event) => {
    // event.properties is { title?, message, variant, duration }
    // The TUI's built-in consumer has already shown the toast.
    // Your handler runs in addition — useful for, e.g., analytics, history logging.
  })
  api.lifecycle.onDispose(off)
}
```

## 7. Bidirectional through the agent: custom tools

A server plugin can register a tool that the LLM agent calls. The tool result is rendered in the chat as a part. This is the only path today that *naturally* crosses both directions in one round-trip — the LLM invokes, the server executes, the TUI displays.

```ts
// Server plugin
import { tool, type Plugin } from "@opencode-ai/plugin"
import { z } from "zod"

export const Server: Plugin = async (input) => {
  return {
    tool: {
      "check_ci_status": tool({
        description: "Fetch CI status for the current branch",
        args: {
          branch: z.string().describe("Branch name, default current"),
        },
        async execute(args, ctx) {
          // Use input.client, or hit GitHub directly.
          const status = await fetchCi(args.branch)
          ctx.metadata({ title: `CI: ${status.state}` })
          return {
            title: `CI ${status.state}`,
            output: [
              `Branch: ${args.branch}`,
              `State: ${status.state}`,
              `URL: ${status.url}`,
            ].join("\n"),
            metadata: { commit: status.sha, runId: status.id },
          }
        },
      }),
    },
  }
}
```

The TUI renders the tool call and tool result as standard parts of the assistant message — no extra wiring needed. The user sees the title, can expand the output, and can copy the metadata. If you need additional TUI side-effects, pair it with a TUI plugin that watches the part:

```ts
// TUI plugin (same package)
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

export const Tui: TuiPlugin = async (api) => {
  const off = api.event.on("message.part.updated", (event) => {
    if (event.properties.part.type === "tool" && event.properties.part.tool === "check_ci_status") {
      const meta = event.properties.part.state?.metadata as { commit?: string } | undefined
      if (meta?.commit) {
        api.ui.toast({
          title: "CI finished",
          message: `Commit ${meta.commit.slice(0, 7)} — see chat for details`,
          variant: "success",
          duration: 4000,
        })
      }
    }
  })
  api.lifecycle.onDispose(off)
}
```

This is the **canonical "show a result in the chat" pattern** — it uses the existing transcript, requires no custom event, and survives reloads.

## 8. Cross-half custom event pattern

For state that doesn't fit a tool result and isn't a built-in `tui.*` event (e.g., "background job progress", "long-running watcher updates"), the only existing cross-process channel is a custom event type on `global.event`.

The trick: pick a unique `type` string, put your payload under `.payload`, and let the TUI plugin listen for it. The server publishes through a custom tool's side effect, or through any code path that ends up in `EventV2Bridge`.

A practical way to do this from a server plugin today, without depending on internal modules, is to use a **custom tool** to publish:

```ts
// Server plugin
import { tool, type Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import { GlobalBus } from "@opencode-ai/util/bus"  // adjust import to the real path

export const Server: Plugin = async (input) => {
  return {
    tool: {
      "emit_progress": tool({
        description: "Emit a progress event visible to TUI plugins. Internal use only.",
        args: { stage: z.string(), pct: z.number().min(0).max(100) },
        async execute(args, ctx) {
          GlobalBus.emit("event", {
            directory: input.directory,
            payload: { type: "myplugin.progress", stage: args.stage, pct: args.pct },
          })
          return { output: "ok" }
        },
      }),
    },
  }
}
```

```ts
// TUI plugin
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

export const Tui: TuiPlugin = async (api) => {
  const off = api.event.on("myplugin.progress" as any, (event: any) => {
    // event.properties has { stage, pct }
    api.state.session.list()  // trigger any reactive re-reads you need
  })
  api.lifecycle.onDispose(off)
}
```

Caveats:

- The `type` is checked at the schema layer on the typed event bus. If you want full type safety, add a schema in `packages/schema/src/<your-name>.ts` and have `Event.inventory(...)` include it. That's an upstream change; for a plugin-only solution, the `as any` cast is the standard escape hatch.
- `directory` filtering happens in `EventV2Bridge`, so the event only reaches TUIs in the matching project.

If you'd rather not depend on `GlobalBus` from a plugin (it's an internal module path), the alternative is to expose a tiny server plugin helper:

```ts
// packages/your-plugin/src/server.ts
import type { Plugin } from "@opencode-ai/plugin"
import { publish } from "./publish"  // wraps the internal publish

export const Server: Plugin = async (input) => {
  return {
    "experimental.text.complete": async ({ sessionID, partID }, output) => {
      // or any other hook that fires regularly
      await publish(input.directory, { type: "myplugin.tick", ts: Date.now() })
    },
  }
}
```

## 9. One package, both halves

`PluginModule` allows both `server` and `tui` fields — but the runtime types are mutually exclusive at the top level: server packages have `{ server }`, TUI packages have `{ tui }`. If you want to ship both, you export two module objects, one per runtime, and the user's config loads each into the right runtime.

```ts
// packages/your-plugin/src/index.ts
import { defineConfig } from "@opencode-ai/config"
import { Server } from "./server"
import { Tui } from "./tui"

// Server-side entry. Goes into opencode.json's `plugin` array.
export const ServerModule = {
  id: "your-plugin",
  server: Server,
}

// TUI-side entry. Goes into tui.json's `plugin_origins` or via the in-TUI
// plugin manager UI.
export const TuiModule = {
  id: "your-plugin",
  tui: Tui,
}
```

User's `opencode.json` (server):

```json
{
  "plugin": ["your-plugin"]
}
```

User's `tui.json` (TUI):

```json
{
  "plugin_origins": ["your-plugin"]
}
```

Inside the package, both files import from shared modules:

```ts
// packages/your-plugin/src/shared.ts
export const CHANNEL = "your-plugin.v1"

export type ProgressEvent = { type: typeof CHANNEL; stage: string; pct: number }
```

## 10. Decision matrix

| I want to… | Use |
|---|---|
| Read or write server data from the TUI | `api.client.*` (§4) |
| React to a session/message/part lifecycle event in the TUI | `api.event.on("session.*" \| "message.*" \| "message.part.*", ...)` (§5) |
| Show a toast in the TUI from a server-side event | `tui.toast.show` event (§6) |
| Run a slash command in the TUI from a server plugin | `tui.command.execute` event (§6) |
| Append text to the user's prompt from a server plugin | `tui.prompt.append` event (§6) |
| Navigate to a session from a server plugin | `tui.session.select` event (§6) |
| Have the LLM call my plugin and have the result land in the chat | `Hooks.tool` with a `tool({...})` definition (§7) |
| Stream progress from a long-running job to the TUI | Custom `global.event` type + custom tool side effect (§8) |
| Inject UI into a TUI slot (`home_bottom`, `sidebar_*`, `session_prompt`, etc.) | `api.slots.register({...})` |
| Add a full screen | `api.route.register([{ name, render }])` |
| Show a dialog/prompt/select | `api.ui.DialogAlert/DialogConfirm/DialogPrompt/DialogSelect` |
| Persist plugin state across reloads | `api.kv.get/set` |
| Modify what gets sent to the LLM | `chat.params`, `chat.headers`, `experimental.chat.messages.transform`, `experimental.chat.system.transform` |
| Customize the compaction prompt | `experimental.session.compacting` |
| Skip the synthetic "continue" message after compaction | `experimental.compaction.autocontinue` (set `enabled: false`) |
| Replace a tool's argument schema / description for the LLM | `tool.definition` |
| Inspect a tool's args before execution | `tool.execute.before` |
| Mutate a tool's title / output / metadata after execution | `tool.execute.after` |
| React to every event on the bus | `event` hook |
| React to a permission prompt | `permission.ask` |
| Modify the env of a shell call | `shell.env` |
| Register a workspace adapter | `input.experimental_workspace.register(type, adapter)` |
| Customize auth for a provider | `Hooks.auth` (oauth / api types) |
| Customize the provider list | `Hooks.provider` |
| Pick a "small model" for a provider | `experimental.provider.small_model` |

## 11. Gotchas and common mistakes

### a. Process identity is real

TUI and server plugins run in **different processes**. They cannot share closures, singletons, or in-memory state. Every byte of state crossing the boundary must be serialized.

- `api.kv` is in the TUI process.
- `input.client.config` / `input.client.global` mutations persist on the server.
- If you need shared state, put it on the server and read it from the TUI through the SDK.

### b. Events are filtered by `directory`

`EventV2Bridge` only routes events whose `location.directory` matches the current instance. If you emit an event without `directory` (or with the wrong one), the TUI never sees it. The targeted `tui.*` events are also filtered by `workspace` (see `packages/tui/src/app.tsx:985-1006`).

### c. The TUI's `api.client` is the same SDK as a remote caller's

There's no "plugin-side" SDK. If you find yourself wanting to call a method the SDK doesn't expose, you need to add it to the SDK (which means adding it to the OpenAPI spec, running `bun run generate` in `packages/client`, and exporting it).

### d. `api.state` is a snapshot, not a signal

`api.state.session.list()` returns a fresh array every call. To get live updates, subscribe to `api.event.on("session.updated", ...)` and re-read.

### e. Plugins are re-evaluated on reload

When a plugin file changes, the host calls your `tui` function again with a fresh `api`. State in module-level closures outside the function survives; state inside the function is lost. Use `meta.state`:

```ts
const tui: TuiPlugin = async (api, options, meta) => {
  if (meta.state === "first") {
    // Initialize persistent state.
  }
  // `api.kv` is the right place for state that should survive reloads.
}
```

### f. The Worker RPC is not a plugin channel

Methods on `rpc` in `packages/opencode/src/cli/tui/worker.ts` (`fetch`, `snapshot`, `server`, `checkUpgrade`, `reload`, `shutdown`) are CLI-thread-internal. Plugins cannot call them. Use the SDK.

### g. The TUI's `api.event.on` returns a dispose

Always store the returned function and call it from `api.lifecycle.onDispose`. Otherwise the handler leaks across reloads.

```ts
const off = api.event.on("session.updated", handler)
api.lifecycle.onDispose(off)
```

### h. Tool calls show up as parts, not events

A custom tool's result is a *part* of an assistant message, not a discrete event. The `message.part.updated` event fires when the part is created/updated, with the part under `event.properties.part`. If you need to react to a tool result, listen for `message.part.updated` and filter by `part.type === "tool" && part.tool === "your_tool"`.

### i. Auth and provider hooks are heavyweight

`Hooks.auth` and `Hooks.provider` are how internal plugins (codex, copilot, gitlab, etc.) customize provider setup. They're meant for plugins that need their own OAuth/API flow. Don't use them for a custom LLM endpoint — that's a `chat.params` job.

### j. `api.theme` is for the TUI; provider-side styling is separate

`api.theme.set(name)` and `api.theme.install(jsonPath)` only affect the TUI's rendering. Server-side prompts and tool results don't have a theme; if you need formatted output for the LLM, return markdown from your tool.

## 12. Debugging tips

- **`tmux new-session -d -s opencode-dev 'bun dev'`** then **`tmux capture-pane -pt opencode-dev`** to see TUI logs (per `packages/opencode/AGENTS.md`). Stop with `tmux kill-session -t opencode-dev`.
- **Add `console.log` in your TUI plugin** — it shows in the captured pane.
- **Add `console.log` in your server plugin** — it shows in the worker's stdout. If you started via `bun dev`, that's the same tmux pane.
- **Trace a single `tui.toast.show` flow** by adding `console.log` at:
  - server: the tool that publishes
  - worker: inside `GlobalBus.on("event", ...)` (`cli/tui/worker.ts:23`)
  - CLI thread: inside `createEventSource(client)` (`cli/cmd/tui.ts:42-50`)
  - TUI: inside `event.on("tui.toast.show", ...)` (`packages/tui/src/app.tsx:990`)
- **Verify the SDK call** with `curl` against the same server your plugin sees. With `external` mode, that's the printed URL. With default in-process mode, you can run `opencode serve --port 4096` separately and point curl at it.
- **Check `api.tuiConfig`** in the TUI to see exactly which plugin origins and config flags were loaded.
- **Check `api.plugins.list()`** to confirm your plugin is registered and `active: true`.

## 13. Key files

- `packages/opencode/src/cli/tui/worker.ts` — worker RPC + `global.event` forwarding
- `packages/opencode/src/cli/cmd/tui.ts` — transport selection, plugin host wiring
- `packages/opencode/src/util/rpc.ts` — RPC protocol
- `packages/opencode/src/bus/global.ts` — server-side event bus
- `packages/opencode/src/event-v2-bridge.ts` — bridges `EventV2` to `GlobalBus`
- `packages/opencode/src/plugin/index.ts` — server plugin Effect service
- `packages/opencode/src/plugin/tui/runtime.ts` — TUI plugin host
- `packages/opencode/src/server/routes/instance/httpapi/handlers/tui.ts` — `tui.*` HTTP handlers
- `packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts` — `tui.*` HTTP schema
- `packages/schema/src/tui-event.ts` — `tui.toast.show`, `tui.command.execute`, `tui.prompt.append`, `tui.session.select`
- `packages/plugin/src/index.ts` — `PluginInput`, `Plugin`, `PluginModule`, `Hooks`
- `packages/plugin/src/tui.ts` — `TuiPluginApi`, `TuiPlugin`, `TuiPluginModule`, slot map
- `packages/plugin/src/tool.ts` — `tool()` factory, `ToolContext`, `ToolResult`
- `packages/plugin/src/example.ts` — minimal server plugin
- `packages/plugin/src/example-workspace.ts` — workspace adapter example
- `packages/tui/src/app.tsx` — TUI app + `tui.*` event consumers (lines 985-1006)
- `packages/tui/src/context/sdk.tsx` — SDK + EventSource + SSE fallback
- `packages/tui/src/context/event.ts` — typed event subscription
- `packages/tui/src/plugin/runtime.tsx` — Solid `createPluginRuntime()`
- `packages/tui/src/plugin/adapters.tsx` — `createTuiApiAdapters` (Solid contexts → `TuiPluginApi`)
- `packages/tui/src/plugin/slots.tsx` — slot registry on `@opentui/solid`
- `packages/tui/src/feature-plugins/builtins.ts` — built-in plugin registry
- `packages/tui/src/feature-plugins/system/plugins.tsx` — built-in `plugin-manager` UI
- `.opencode/plugins/tui-smoke.tsx` — canonical TUI plugin example
- `packages/sdk/js/src/gen/client.gen.ts` and `v2/gen/client.gen.ts` — auto-generated SDK clients
