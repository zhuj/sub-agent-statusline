# Testing

This project uses **Vitest** for automated tests and **@vitest/coverage-v8** for coverage reports. The goal is to keep the fast, deterministic behavior covered in tests while avoiding brittle host-driven TUI automation too early.

## Strategy overview

The suite uses deterministic unit tests and focused TUI integration seams:

- **Pure core tests** cover events, state, projection, rendering, reconciliation, terminal text width, descendant discovery, and tree-row layout. They protect parsed session data, state transitions, all-depth parent-before-child ordering, counters, formatting, and malformed-input safety.
- **Focused TUI tests** cover lifecycle, persistence coordination, event ownership, route-scoped behavior, and commands without launching a full OpenCode/OpenTUI host.

Deep visual TUI and full OpenCode host end-to-end automation are intentionally deferred. The current baseline is 351 passing tests across 17 files.

## Test file map

| File | What it validates |
| --- | --- |
| `src/events.test.ts` | Event parsing, session ID extraction, event-to-state updates, details/token normalization, and malformed event safety. |
| `src/state.test.ts` | State invariants, counters, transitions, pruning, persistence helpers, environment path resolution, and detail merging. |
| `src/projection.test.ts` | Pure all-depth lineage projection, parent-before-child order, correlation, counters, and cycle safety. |
| `src/tui-descendant-hydration.test.ts` | Iterative bounded descendant discovery, cancellation, fail-closed filtering, and one-batch updates. |
| `src/tui-tree-row.test.ts` | Pure tree-row indentation, narrow-width clamping, labels, and nested navigation targets. |
| `src/render.test.ts` | Statusline rendering, visibility rules, collapse behavior, duration/token formatting, and color/no-color output semantics. |
| `src/text-width.test.ts` | Terminal column width helpers for CJK/full-width text, combining marks, and truncation within display budgets. |
| `src/persistence.test.ts` | Persistence coordination, coalescing, flush behavior, and metadata preservation. |
| `src/tui.test.ts` | TUI lifecycle, persistence, commands, keybindings, and integration seams. |
| `test/package-contract.test.ts` | Root and `/tui` exports plus absence of removed source and build artifacts. |
| `test/helpers/test-harness.ts` | Reusable helpers for isolated temp dirs, env overrides, fixtures, filesystem assertions, and fake-time setup. |
| `test/setup.ts` | Global cleanup after each test: timers, mocks, selected env vars, and registered temp directories. |
| `test/fixtures/events/*.json` | Canonical valid and malformed event payloads used by tests. |

## Arrange / Act / Assert

Use the **Arrange / Act / Assert** pattern to keep tests readable:

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

Keep assertions semantic. Prefer checking meaningful counters, titles, statuses, file contents, or rendered text over snapshots of large objects.

## Running tests

Install dependencies first with lifecycle scripts disabled by default:

```sh
pnpm install --ignore-scripts
```

Run the full suite once:

```sh
pnpm test
```

Run tests in watch mode while developing:

```sh
pnpm test:watch
```

Generate coverage:

```sh
pnpm test:coverage
```

Run TypeScript checks:

```sh
pnpm typecheck
```

## Adding a unit test

1. Pick the module behavior you want to protect.
2. Add or extend the co-located test file: `src/events.test.ts`, `src/state.test.ts`, `src/render.test.ts`, or another focused unit test such as `src/text-width.test.ts`.
3. Arrange minimal inputs. Reuse existing helpers or fixtures only when they make the test clearer.
4. Act by calling the public function under test.
5. Assert behavior, not implementation details.

Example shape:

```ts
it("renders an empty summary", () => {
  const state = createEmptyState();

  const output = renderStatusline(state);

  expect(output).toContain("0 running");
  expect(output).toContain("0 done");
});
```

If a case depends on time, use `useFrozenTime(...)` from `test/helpers/test-harness.ts` or Vitest fake timers directly, and let `test/setup.ts` restore real timers after the test.

## Adding an isolated filesystem test

Use `test/helpers/test-harness.ts` when a state or persistence test needs an isolated filesystem and environment:

```ts
it("writes an isolated state snapshot", async () => {
  const harness = await createFileHarness();
  const state = createEmptyState();

  await saveState(harness.statePath, state);

  expect(await pathExists(harness.statePath)).toBe(true);
});
```

Useful helpers:

- `createFileHarness()` creates a temp directory and isolated `state.json` and `status.txt` paths.
- `readJsonFixture(name)` loads `test/fixtures/events/<name>.json`.
- `pathExists(path)` checks filesystem output without throwing.
- `useFrozenTime(isoTimestamp)` enables fake timers and pins the current time.

Add new event fixtures under `test/fixtures/events/` when the same payload is useful across tests. Keep fixtures small and representative.

## What not to test yet

Do not add deep TUI/e2e automation for `src/tui.tsx` yet. Full OpenCode host automation, visual snapshots, and broad OpenTUI rendering assertions remain deferred.

For now, prefer:

- unit tests for pure formatting and state behavior;
- focused tests for projection, descendant discovery, tree rows, persistence, and event handling;
- manual smoke testing in OpenCode when changing the actual TUI surface.

## Troubleshooting and gotchas

### Fake timers

If a test uses fake timers, make sure it is explicit in the Arrange step. `test/setup.ts` calls `vi.useRealTimers()` after each test, but a test should still avoid leaking timer state through shared module-level values.

### Temporary directories

Use `createFileHarness()` instead of hard-coded paths. It registers temp directories for cleanup and points `OPENCODE_SUBAGENT_STATUSLINE_STATE` at an isolated `state.json`.

### Environment variables

The setup file restores the plugin-related env vars after each test. If you add a new env var that tests mutate, add it to `envKeys` in `test/setup.ts`.

### Avoid brittle snapshots

Snapshots can hide intent and break on harmless formatting changes. Prefer focused assertions like:

```ts
expect(output).toContain("1 running");
expect(output).toContain("Review auth changes");
```

Use snapshots only when the whole rendered shape is the behavior being protected and the output is intentionally stable.

### Write failures

Filesystem tests can simulate write failures by making the expected state path a directory. Keep these tests small and assert the documented best-effort behavior.

## Build and package gates

The build has one output pair, `dist/tui.js` and `dist/tui.d.ts`. The root package export and `/tui` both resolve to that TUI bundle.

Run these gates when build or package metadata changes:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

For visible TUI changes, point OpenCode at the built `dist/tui.js`, restart it, run nested delegations, and verify all descendant depths, row order, navigation, status, duration, and optional token/context display.
