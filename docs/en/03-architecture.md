# Architecture

The plugin is organized around a pipeline: receive OpenCode events, normalize them into internal state, deduplicate technical representations, and render a useful TUI view.

```txt
OpenCode
  ├─ session events
  ├─ message events
  └─ part/tool-call events
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
Main TUI plugin
Sidebar / footer / local snapshots
```

## Module map

| File | Responsibility |
| --- | --- |
| `src/tui.tsx` | Main TUI plugin: slots, sidebar, footer, all-depth hydration, reconciliation, navigation, persistence, and lifecycle. |
| `src/events.ts` | Converts OpenCode events into internal state mutations. |
| `src/state.ts` | Defines the data model, counters, persistence, and mutation helpers. |
| `src/projection.ts` | Builds the cached descendant lineage index, scoped rows, depths, and counters. |
| `src/render.ts` | Formats rows, collapses duplicates, filters visibility, and builds statusline text. |
| `src/reconcile.ts` | Normalizes OpenCode statuses and safely closes stale `running` cases. |
| `src/tui-commands.ts` | Registers commands and keybindings, especially `Alt+B`. |
| `src/*.test.ts` | Unit tests for deterministic core behavior. |

## Entrypoints

### TUI plugin

Source: `src/tui.tsx`

This is the package's only supported plugin endpoint, available through two package entrypoints:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
```

Main responsibilities:

- register the TUI plugin with id `subagent-statusline.tui`;
- mount the UI with Solid/OpenTUI;
- listen to relevant OpenCode events;
- render the subagent sidebar;
- render a bottom home summary;
- register commands and shortcuts;
- hydrate existing subagents when navigating between sessions;
- reconcile stale `running` items;
- persist TUI-owned `state.json` and `status.txt` snapshots;
- write `tui-events.log` when event diagnostics are enabled.

## Internal model

The central state lives in `src/state.ts`.

Simplified shape:

```ts
type StatuslineState = {
  children: Record<string, ChildSessionState>;
  countedChildIDs: string[];
  totalExecuted: number;
  updatedAt: string;
};
```

Each child represents a unit of evidence related to delegated work:

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

The detailed model is covered in [State model and counters](./05-state-model-and-counters.md), but the base rule is:

> State stores evidence. Rendering decides what is visible. Counters decide what was real execution.

## Sources: session, subtask, and tool

The plugin must distinguish where each work item came from.

| Source | Typical origin | Use |
| --- | --- | --- |
| `session` | OpenCode `session.*` events with a real child session. | Strongest source. Counts as real execution. |
| `subtask` | Message parts describing a subtask. | Early/provisional display and correlation evidence; does not count as execution. |
| `tool` | Tool calls such as `task` or `delegate`. | Status evidence; does not count as execution. |

This split exists because OpenCode may first report a technical wrapper and reveal the real session later, or expose incomplete data across multiple events.

## Event pipeline

`src/events.ts` receives OpenCode events and decides whether they should affect state.

| Event | Possible meaning |
| --- | --- |
| `session.created` | A real child session appeared. |
| `session.updated` | A session changed. |
| `session.status` | A normalized session status changed. |
| `session.idle` | The session became idle, usually `done`. |
| `session.error` | The session failed. |
| `message.updated` | May contain completion evidence for subtasks. |
| `message.part.updated` | May represent subtasks or `task`/`delegate` wrappers. |

`events.ts` does not render. Its job is to turn variable signals into consistent `StatuslineState` mutations.

## State and counters

`src/state.ts` owns important invariants:

- create or update running children;
- mark children as `done` or `error`;
- merge title, summary, agent, target, and token details;
- refresh durations and derived fields;
- persist TUI-owned state and text snapshots;
- prune old terminal children;
- keep `totalExecuted` free of duplicates.

Critical rules:

- synthetic `source: "tool"` and `source: "subtask"` rows do not enter `countedChildIDs` or increment `totalExecuted`;
- each observed real `ses_*` session counts exactly once;
- a subtask may appear before, then correlate with and navigate to, a later real session without counting itself;
- when the real session appears, its `ses_*` identity is the only identity added to execution counters;
- persisted snapshots keep shared state and render output available to local tools without becoming token evidence.

## Rendering

`src/render.ts` does not simply print `state.children`.

Before showing anything, it:

1. selects the complete retained descendant subtree;
2. collapses duplicates and correlates real sessions with provisional rows;
3. sorts siblings by the existing priority rules;
4. emits parents before children with a depth for each row;
5. filters old `done` rows while keeping errors and running items visible;
6. builds the aggregate summary.

That is why there can be more children in state than visible rows in the UI.

## TUI runtime

`src/tui.tsx` is the largest module because it integrates several OpenCode runtime concerns.

It handles initialization, visual slots, the sidebar, hydration, reconciliation, token/context best-effort loading, navigation, prompt focus preservation, local persistence, and lifecycle cleanup.

The sidebar shows the complete retained descendant tree for the current session. Home summary and text/status-file rendering remain global across sessions. Rows are navigable only when a real `ses_*` target is known.

## Descendant discovery and projection

Cold hydration walks `session.children(parentID)` iteratively from the viewed session. The breadth-first traversal has fixed request concurrency, queries each real session ID at most once, and continues through every discovered depth. A visited set prevents cycles and duplicate requests. Route changes and aborts stop stale work, while verified partial results follow the existing retry policy.

The shared lineage projection selects that all-depth subtree once per immutable state snapshot. It correlates duplicates once, sorts siblings by priority, and emits a depth-first parent-before-child row order. Only authoritative real session relationships can extend ancestry. Synthetic targets remain correlation and navigation evidence, not ancestry evidence.

Token/context hydration uses live TUI state plus `session.messages`. Local databases, `state.json`, `status.txt`, and event logs are not token-recovery sources.

## Reconciliation

`src/reconcile.ts` contains helpers for interpreting OpenCode statuses and avoiding unsafe closures.

| OpenCode | Internal status |
| --- | --- |
| `busy`, `running`, `pending`, `queued`, `working`, `compacting`, `retry` | `running` |
| `idle`, `done`, `completed`, `complete`, `success`, `succeeded` | `done` |
| `error`, `failed`, `failure`, `cancelled`, `canceled`, `aborted` | `error` |

Unknown statuses are treated as inconclusive instead of guessed.

## Commands and keybindings

`src/tui-commands.ts` registers TUI commands.

| Command | Action |
| --- | --- |
| `Subagents: Toggle sidebar section` | Enable or disable the subagent section. |
| `Subagents: Focus sidebar list` | Move focus to the subagent list. |
| `Subagents: Toggle completed history` | Toggle retained completed rows in the sidebar. |

Main shortcut:

```txt
Alt+B
```

The plugin prefers the modern keymap API when available and falls back to the legacy command API otherwise.

## Testing as architecture contract

Tests document design decisions as much as they verify code.

| Test | What it protects |
| --- | --- |
| `src/events.test.ts` | Event parsing, correlation, and fail-closed ambiguity handling. |
| `src/state.test.ts` | Counters, persistence, normalization, and source rules. |
| `src/render.test.ts` | Collapse, visibility, formatting, and aggregate summary. |
| `src/reconcile.test.ts` | Status normalization and conservative reconciliation. |
| `src/projection.test.ts` | All-depth lineage, correlation, ordering, counters, and cycle safety. |
| `src/tui-descendant-hydration.test.ts` | Iterative bounded discovery, cancellation, batching, and fail-closed responses. |
| `src/tui-tree-row.test.ts` | Depth indentation, narrow-width clamping, and nested navigation targets. |
| `src/tui.test.ts` | TUI lifecycle, persistence, commands, keybindings, and integration seams. |

Current boundary: the full visual UI in `src/tui.tsx` does not have deep E2E coverage against the OpenCode/OpenTUI host.

## Relevant configuration files

| File | Role |
| --- | --- |
| `package.json` | Package name, exports, scripts, peers, and release metadata. |
| `tsup.config.ts` | Single TUI build that emits `dist/tui.js` and `dist/tui.d.ts`. |
| `tsconfig.json` | Base TypeScript config for source. |
| `tsconfig.test.json` | TypeScript config for tests. |
| `vitest.config.ts` | Vitest, coverage, and setup. |
| `.github/workflows/ci.yml` | PR and `main` push CI: typecheck, tests, audit, and package checks. |
| `.github/workflows/release.yml` | Stable tag-gated npm publication and GitHub Release notes. |

## Important design decisions

1. **Do not break OpenCode**: auxiliary operations are best-effort.
2. **Do not force ambiguous correlations**: missing evidence stays unresolved.
3. **Counters are semantic**: they count real work, not rows or events.
4. **The TUI hydrates historical data**: it does not rely only on live events.
5. **Tokens/context are optional**: they are shown only when evidence exists.

## Next reading

Continue with:

- [Event flow](./04-event-flow.md)
- [State model and counters](./05-state-model-and-counters.md)
- [Rendering and deduplication](./06-rendering-and-deduplication.md)
