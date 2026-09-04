# Overview

`opencode-subagent-statusline` is an OpenCode TUI plugin that shows subagent activity inside the interface: running subagents, completed subagents, failures, elapsed time, and token/context usage when OpenCode exposes that information.

The core idea is simple:

> When work is delegated to subagents, the plugin keeps that activity visible so users do not have to reconstruct it from events, logs, or child sessions.

## Problem it solves

OpenCode can run delegated work through child sessions or through tools such as `task` and `delegate`. That is useful, but it creates a visibility problem: activity can be split across session events, message parts, and technical wrappers.

Without a dedicated view, it is hard to answer questions like:

- Is a subagent still running?
- Did it finish successfully or fail?
- Which child session is the real one?
- How long has it been running?
- How much context did it use?
- Am I seeing real work or a duplicated technical wrapper?

This plugin collects those signals and turns them into a compact TUI view.

## What it shows

In the TUI, the plugin can show:

- running subagents;
- recently completed subagents;
- failed subagents;
- estimated duration;
- token and context usage when available;
- an aggregate summary on the home screen;
- navigation to the real child session when a navigable `sessionID` exists.

## Public entrypoints

The package exposes these entrypoints:

| Entrypoint                         | Source         | Primary use                                                  |
| ---------------------------------- | -------------- | ------------------------------------------------------------ |
| `opencode-subagent-statusline`     | `src/tui.tsx`  | Main TUI plugin. Recommended path for users.                 |
| `opencode-subagent-statusline/tui` | `src/tui.tsx`  | Explicit alias for the TUI plugin.                           |

The TUI plugin is the only delivery channel. It is in-memory and does not write
files outside the OpenCode plugin context.

## High-level flow

```txt
OpenCode event
  -> src/events.ts
  -> src/state.ts
  -> src/render.ts
  -> src/tui.tsx
  -> sidebar / home footer
```

Step by step:

1. **OpenCode emits events**
   - For example: `session.created`, `session.status`, `message.part.updated`.

2. **The plugin extracts subagent evidence**
   - `src/events.ts` interprets session events, subtasks, and tool wrappers.

3. **Internal state is updated**
   - `src/state.ts` stores children, statuses, timing, tokens, and counters.

4. **Rendering decides what is visible**
   - `src/render.ts` collapses duplicates, filters old rows, and builds aggregate text.

5. **The TUI displays the information**
   - `src/tui.tsx` registers slots, commands, navigation, hydration, and reconciliation.

## Key concept: not every event is a real execution

This is the most important concept in the project.

OpenCode can represent delegated work in several ways:

| Internal source | What it represents                                          | Counts as execution      |
| --------------- | ----------------------------------------------------------- | ------------------------ |
| `session`       | A real OpenCode child session.                              | Yes, once.               |
| `subtask`       | A synthetic row derived from message parts.                 | May count provisionally. |
| `tool`          | A technical wrapper for tools such as `task` or `delegate`. | No.                      |

The plugin therefore separates three concepts:

1. **Stored state**: everything the plugin knows.
2. **Visible rows**: what should be shown after duplicate collapse.
3. **Executed total**: the semantic count of real work.

A visible row does not always equal one execution. A `tool:*` wrapper can provide status evidence, but it must not inflate `totalExecuted`.

## Defensive design

The plugin works with event shapes that can vary by OpenCode version, delegation type, and event timing.

That is why the design is conservative:

- ambiguous correlations are not forced;
- multiple possible session IDs are not guessed;
- old running sessions are not blindly closed;
- missing token/context information is safely omitted;
- auxiliary state/debug write failures should not crash OpenCode.

This strategy appears throughout the code and tests as **fail-closed** behavior.

## What is tested

The deterministic core has strong test coverage for:

- event parsing;
- state transitions;
- counters and deduplication;
- text rendering;
- conservative reconciliation;
- basic command/keybinding registration.

The current boundary is the full visual UI inside the OpenCode/OpenTUI host: deep TUI E2E automation does not exist yet. For visual changes, the project recommends manual OpenCode smoke tests in addition to automated tests.

## Next reading

Continue with:

- [Architecture](./03-architecture.md)
- [Event flow](./04-event-flow.md)
- [State model and counters](./05-state-model-and-counters.md)
- [Rendering and deduplication](./06-rendering-and-deduplication.md)
