# State model and counters

The plugin's internal state lives in `src/state.ts`. Its job is to store subagent evidence, maintain invariants, and count real executions without duplicating technical wrappers.

Main idea:

> `children` stores what the plugin knows. `totalExecuted` counts real work. The UI may show fewer rows than the state stores.

## Central state

The main state type is `StatuslineState`.

Simplified shape:

```ts
type StatuslineState = {
  children: Record<string, ChildSessionState>
  countedChildIDs: string[]
  totalExecuted: number
  updatedAt: string
}
```

| Field | Meaning |
| --- | --- |
| `children` | Map of known work items: real sessions, subtasks, and wrappers. |
| `countedChildIDs` | Observed real `ses_*` identities that already counted as execution. |
| `totalExecuted` | Semantic total of real executions. |
| `updatedAt` | Last derived state update. |

## ChildSessionState

Each `children` entry represents an item related to delegated work.

Simplified shape:

```ts
type ChildSessionState = {
  id: string
  parentID?: string
  messageID?: string
  targetSessionID?: string
  source?: "session" | "subtask" | "tool"
  status: "running" | "done" | "error"
  title?: string
  summary?: string
  agent?: string
  startedAt?: string
  updatedAt?: string
  endedAt?: string
  elapsedMs?: number
  color?: string
  tokenState?: ChildTokenState
}
```

## Sources

`source` is the key field for understanding behavior.

| Source | Represents | Example ID | Counts as execution |
| --- | --- | --- | --- |
| `session` | Real OpenCode child session. | `ses_abc123` | Yes, once. |
| `subtask` | Synthetic representation of a message part. | `subtask:prt_1` | No. |
| `tool` | Technical tool-call wrapper. | `tool:prt_2` | No. |

Counters use this classification, not duration or visibility.

## Internal statuses

The plugin reduces many possible statuses to three internal values:

```txt
running | done | error
```

| Status | Meaning |
| --- | --- |
| `running` | Evidence of active or pending work. |
| `done` | Evidence of successful/idle completion. |
| `error` | Evidence of error, cancellation, or failure. |

Color and elapsed duration are derived fields refreshed from state.

## ID vs targetSessionID

`id` identifies the internal state entry.

`targetSessionID` identifies the real navigable session, when known.

```ts
{
  id: "subtask:prt_1",
  source: "subtask",
  targetSessionID: "ses_child"
}
```

That means:

- the internal item is still the subtask;
- the associated real session is `ses_child`;
- the UI can navigate to `ses_child`;
- the synthetic row remains excluded from execution counters;
- observing the real `ses_child` session adds that identity to the counters once;
- rendering can merge real session data into the synthetic row.

## Counting rules

The plugin counts real executions, not events or rows.

Rules:

1. Synthetic `source: "tool"` and `source: "subtask"` rows never enter `countedChildIDs` or increment `totalExecuted`.
2. `source: "session"` increments once per observed real `ses_*` identity.
3. A synthetic row can appear before a real session and later provide correlation or navigation through `targetSessionID` without counting.
4. When the real session appears, only its `ses_*` identity enters `countedChildIDs`.
5. Repeated updates of the same real session do not count again.

## Why `tool` does not count

A `tool:*` wrapper represents the technical call, not necessarily the real work.

```txt
tool:prt_task  -> task wrapper
ses_child      -> real session created by that task
```

If both counted, one delegation would become two executions.

Therefore:

```txt
tool:prt_task = evidence, not execution
ses_child     = real execution
```

Even a wrapper with nonzero duration still does not count. The rule is based on `source`, not timing heuristics.

## Real session counting

When a real session arrives:

```ts
upsertRunningChild(state, {
  id: "ses_child",
  source: "session",
  parentID: "ses_parent",
  targetSessionID: "ses_child"
})
```

The plugin:

1. creates or updates `children["ses_child"]`;
2. checks whether that identity was already counted;
3. increments `totalExecuted` if it was not counted;
4. records the identity in `countedChildIDs`.

A later update for `ses_child` does not increment again.

## Synthetic rows before a real session

Sometimes a `subtask` appears before the real session.

```txt
subtask:prt_1 appears first
ses_child appears later
```

Before the real session is known, the subtask can be visible but remains uncounted:

```ts
countedChildIDs = []
totalExecuted = 0
```

Adding `targetSessionID` can make the synthetic row correlatable and navigable. That metadata alone still does not count an execution. When the real session is observed, its identity counts once:

```ts
countedChildIDs = ["ses_child"]
totalExecuted = 1
```

Rendering may keep the synthetic title and merge status, timing, or token data from the real session into one visible row. Visibility and correlation do not change the counting rule.

## Correlation without synthetic rekeying

There is no counted synthetic identity to rekey. A `subtask:*` or `tool:*` ID remains outside `countedChildIDs`, even if it gains a trusted `targetSessionID`.

```txt
Before the real session: countedChildIDs = []
After observing it:     countedChildIDs = ["ses_child"]
```

The projection can still correlate entries when:

- a synthetic row gets a trusted `targetSessionID`;
- a correlated real session appears.

The real session supplies the sole execution identity. The correlated synthetic row can supply a useful title or navigation target without inflating `totalExecuted`.

## Persistence

State can be saved as JSON.

Default path:

```txt
$XDG_RUNTIME_DIR/opencode-subagent-statusline/<instance>/state.json
```

If `XDG_RUNTIME_DIR` is absent, the system temp directory is used.

`status.txt` lives next to `state.json` and contains the TUI's text snapshot.

Relevant variables:

| Variable | Use |
| --- | --- |
| `OPENCODE_SUBAGENT_STATUSLINE_STATE` | Overrides the `state.json` path. |
| `OPENCODE_SUBAGENT_STATUSLINE_INSTANCE` | Defines the instance name. |
| `XDG_RUNTIME_DIR` | Default base for TUI-owned local files. |

The TUI owns these snapshots, but its authoritative state remains in memory while active.

## Snapshot writes

The TUI writes `state.json` and `status.txt` best-effort through the shared persistence helpers. Snapshot writes preserve owner-only permissions and atomic replacement where the host filesystem supports them.

Before a state snapshot is written, current derived fields and changed-child token/model details are refreshed. The persisted files expose current local status; they are not startup restoration or token-recovery inputs.

Token/context hydration uses live in-memory and event state plus `session.messages`. Persisted snapshots, OpenCode's local database, and recent log files are not recovery sources.

## Derived fields and pruning

State refresh recalculates fields such as:

| Field | Source |
| --- | --- |
| `elapsedMs` | Difference between `startedAt` and `endedAt` or current time. |
| `color` | Derived from `status`. |
| `updatedAt` | Latest known update. |
| tokens/context | Live in-memory/event evidence plus `session.messages`. |

Old terminal children may be pruned to avoid unbounded growth. Terminal rows are
retained for up to 3 days with a 1,500-row cap. Pruning rows must not reduce
`totalExecuted`.

## Main mutation helpers

| Helper | Responsibility |
| --- | --- |
| `createEmptyState()` | Create initial state. |
| `upsertRunningChild()` | Create or update a running child. |
| `markChildStatus()` | Mark a child as `done` or `error`. |
| `upsertChildDetails()` | Merge title, summary, agent, tokens, and target. |
| `refreshDerivedFields()` | Recalculate duration, color, pruning, and timestamps. |
| `saveState()` | Save normalized state to disk. |

## Example flow

```ts
children["tool:prt_task"] = { id: "tool:prt_task", source: "tool", status: "running" }
countedChildIDs = []
totalExecuted = 0

children["subtask:prt_1"] = { id: "subtask:prt_1", source: "subtask", status: "running" }
countedChildIDs = []
totalExecuted = 0

children["ses_child"] = { id: "ses_child", source: "session", targetSessionID: "ses_child", status: "running" }
children["subtask:prt_1"].targetSessionID = "ses_child"

countedChildIDs = ["ses_child"]
totalExecuted = 1
```

Rendering may show one visible row even though state keeps multiple evidence entries.

## Invariants for future changes

- Synthetic `tool:*` and `subtask:*` rows must not enter `countedChildIDs` or increment `totalExecuted`.
- A real session must count exactly once.
- A synthetic row may remain visible, correlate, and become navigable without counting as an execution.
- `targetSessionID` must be used only with safe correlation.
- Snapshot write failures must not crash the TUI.
- Pruning children must not change historical execution totals.
- Counter changes should update `state`, `events`, and `render` tests as needed.

## Related tests

| File | Confirms |
| --- | --- |
| `src/state.test.ts` | Real-session counting, synthetic-row exclusion, persistence, and snapshot sanitization. |
| `src/events.test.ts` | Target extraction and safe correlation. |
| `src/render.test.ts` | Visual collapse without duplicate rows. |
| `src/reconcile.test.ts` | Conservative stale-state closure. |
