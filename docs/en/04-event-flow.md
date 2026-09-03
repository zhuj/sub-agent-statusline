# Event flow

The plugin converts variable OpenCode events into stable internal state. That conversion happens mostly in `src/events.ts`, then flows through `src/state.ts` and `src/render.ts`.

Core rule:

> An event is not displayed directly. It is first interpreted as evidence, then stored in state, and only then converted into a visible row.

## Full flow

```txt
OpenCode event
  ↓
applySubagentEvent(event, state)
  ↓
Evidence extraction
  ↓
StatuslineState mutation
  ↓
refreshDerivedFields(state)
  ↓
collapseSubagentWorkItems(state.children)
  ↓
Sidebar / home footer / status.txt
```

## Events the plugin listens to

| Event | Main use |
| --- | --- |
| `session.created` | Detect a real child session. |
| `session.updated` | Update child session data. |
| `session.status` | Normalize a session status. |
| `session.idle` | Mark a session as completed. |
| `session.error` | Mark a session as failed. |
| `message.updated` | Find completion evidence for subtasks. |
| `message.part.updated` | Detect subtasks or `task`/`delegate` wrappers. |

These events do not always have the same shape. `src/events.ts` therefore looks for data in several payload locations.

## Case 1: a real session appears

This is the direct path.

```txt
session.created
  ↓
extract sessionID + parentID
  ↓
create child source: "session"
  ↓
count one real execution
  ↓
sidebar can show it as running
```

Conceptual event:

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

Expected state:

```ts
children["ses_child"] = {
  id: "ses_child",
  source: "session",
  parentID: "ses_parent",
  targetSessionID: "ses_child",
  status: "running"
}
```

Because `source: "session"` represents real work, `totalExecuted` increases once.

## Case 2: a `subtask` part appears

Sometimes OpenCode exposes delegated work as a message part before exposing a real child session.

```txt
message.part.updated
  ↓
part kind/type = subtask
  ↓
create child id subtask:<partID>
  ↓
may provide an early visible row, but does not count
  ↓
correlate if a real session appears later
```

Conceptual event:

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

Expected state:

```ts
children["subtask:prt_1"] = {
  id: "subtask:prt_1",
  source: "subtask",
  parentID: "ses_parent",
  messageID: "msg_1",
  title: "Review current diff",
  status: "running"
}
```

A `subtask` is useful even before `targetSessionID` is known. It lets the plugin show early delegated work, but it does not enter `countedChildIDs` or increment `totalExecuted`.

## Case 3: a `task` or `delegate` wrapper appears

OpenCode can emit message parts for tool calls. For this plugin, the important ones are `task` and `delegate`.

```txt
message.part.updated
  ↓
part tool = task/delegate
  ↓
create child id tool:<partID>
  ↓
source: "tool"
  ↓
does not count as execution
  ↓
provides status or target evidence
```

Conceptual event:

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

Expected state:

```ts
children["tool:prt_tool"] = {
  id: "tool:prt_tool",
  source: "tool",
  parentID: "ses_parent",
  messageID: "msg_1",
  title: "Run tests",
  status: "running"
}
```

This child may appear in state and provide evidence, but it **does not increment `totalExecuted`**.

## Why wrappers do not count

A `tool:*` wrapper is not necessarily a real execution. It may be only the technical representation of a call that later produces a real session.

If the plugin counted both wrapper and session, totals would be inflated.

| Source | Counts |
| --- | --- |
| `session` | Yes, once per observed real `ses_*` identity. |
| `subtask` | No. |
| `tool` | No. |

## Correlating wrapper, subtask, and session

The same delegated work can appear several times with different shapes:

```txt
1. message.part.updated -> tool:prt_tool
2. message.part.updated -> subtask:prt_subtask
3. session.created      -> ses_child
```

The plugin tries to relate these pieces using evidence such as:

- `targetSessionID`;
- `parentID`;
- `messageID`;
- session IDs found in metadata;
- session IDs parsed from output, for example `task_id: ses_...`;
- title, description, or agent;
- activity and timestamps.

If correlation is safe, rendering can show one row instead of three. If it is ambiguous, the plugin does not force it.

## Target session

`targetSessionID` is the real navigable session ID behind a synthetic row.

```ts
children["subtask:prt_1"] = {
  id: "subtask:prt_1",
  source: "subtask",
  targetSessionID: "ses_child"
}
```

That means:

- the visible row may keep the subtask title;
- navigation can open `ses_child`;
- terminal data from `ses_child` can be merged into the synthetic row;
- the synthetic row remains uncounted; when `ses_child` is observed as a real session, that `ses_*` identity counts once.

## Terminal states

Internal statuses are only:

```txt
running | done | error
```

`src/reconcile.ts` normalizes many OpenCode status words into those statuses.

| OpenCode | Internal status |
| --- | --- |
| `busy`, `running`, `pending`, `queued`, `working`, `compacting`, `retry` | `running` |
| `idle`, `done`, `completed`, `complete`, `success`, `succeeded` | `done` |
| `error`, `failed`, `failure`, `cancelled`, `canceled`, `aborted` | `error` |

Unknown words are treated as inconclusive.

## Session-based completion

A real session can finish through several paths:

```txt
session.idle  -> done
session.error -> error
session.status with terminal value -> done/error
```

When a session becomes terminal, `markChildStatus()` can also update synthetic rows whose `targetSessionID` points to that session.

## Message-based completion

Not all completion evidence arrives as a session event. It can also come from:

- completed tool calls;
- output containing `task_id`;
- completed assistant messages;
- error metadata;
- hydration or reconciliation probes.

This matters for synchronous flows where the real session is not exposed immediately or the technical wrapper is the first available signal.

## Hydration

The TUI does not depend only on live events.

When navigating to a session, `src/tui.tsx` tries to hydrate previous subagents by querying OpenCode APIs for:

- child sessions;
- messages;
- message parts;
- session statuses.

It then transforms that information into internal synthetic events and runs the normal pipeline.

## Reconciling stale running items

Some children can remain `running` when terminal evidence is missing.

The plugin does not close them just because they are old. It first checks:

1. live TUI state;
2. OpenCode client session status;
3. child messages;
4. recent parent activity;
5. stale-running threshold.

Only safe candidates are closed.

## Tokens and context

The TUI hydrates token/context data from:

- live in-memory and event state;
- OpenCode's `session.messages` API.

Persisted snapshots, OpenCode's local database, and recent log files are not recovery sources. If the live/API evidence is absent, rows are shown without token/context details.

## Fail-closed behavior

General rule:

> If there is not enough evidence to correlate, close, or deduplicate, the plugin does not invent a relationship.

| Situation | Behavior |
| --- | --- |
| Output has multiple possible `ses_*` IDs | Do not pick one at random. |
| Two identical subtasks exist in one message | Do not close one by assumption. |
| Wrapper has no target and multiple sibling sessions exist | Do not backfill target. |
| Session probe fails | Do not apply stale fallback. |
| Status is unknown | Keep it inconclusive. |

## Summary

```txt
Live or hydrated event
  ↓
Is it session, subtask, or tool?
  ↓
Is there parent/message/target/session evidence?
  ↓
Update state
  ↓
Normalize status/tokens/timestamps
  ↓
Rebuild counters from observed real sessions
  ↓
Render visible rows
  ↓
Show in TUI or status.txt
```

## Related files

| File | What to inspect |
| --- | --- |
| `src/events.ts` | Event extraction and application. |
| `src/state.ts` | Mutations, counters, and persistence. |
| `src/reconcile.ts` | Normalization and conservative closure. |
| `src/render.ts` | Final collapse and visibility. |
| `src/tui.tsx` | Event subscriptions, hydration, and periodic maintenance. |
| `src/events.test.ts` | Event and correlation cases. |
| `src/reconcile.test.ts` | Fail-closed and stale-running cases. |
