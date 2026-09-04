# Testing

This project uses **Vitest** for automated tests and **@vitest/coverage-v8** for coverage reports. The goal is to keep the fast, deterministic behavior covered in tests while avoiding brittle host-driven TUI automation too early.

## Strategy overview

The suite has one main layer:

- **Unit tests** cover pure logic in `src/events.ts`, `src/state.ts`, `src/render.ts`, `src/reconcile.ts`, `src/tui-commands.ts`, `src/tui-focus.ts`, and focused helpers such as `src/text-width.ts`. These tests should be fast, table-friendly, and focused on behavior: parsed session data, state transitions, counters, formatting, terminal text width, command registration, and safe handling of malformed input.

The plugin is in-memory only: there is no runtime integration layer or filesystem persistence to test. Deep TUI and full OpenCode host end-to-end automation are intentionally deferred.

## Test file map

| File                              | What it validates                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/events.test.ts`              | Event parsing, session ID extraction, event-to-state updates, details/token normalization, and malformed event safety.                                             |
| `src/state.test.ts`               | State invariants, counters, transitions, pruning, and counter normalization.                                                                                       |
| `src/render.test.ts`              | Statusline rendering, visibility rules, collapse behavior, duration/token formatting, and color/no-color output semantics.                                         |
| `src/reconcile.test.ts`           | Status normalization, stale-running gating, exponential backoff, fail-closed behavior.                                                                              |
| `src/tui-commands.ts` tests       | Keymap layer registration, legacy command registration, `Alt+B` keybinding, safe no-op disposer, and disposal error containment.                                  |
| `src/text-width.test.ts`          | Terminal column width helpers for CJK/full-width text, combining marks, and truncation within display budgets.                                                     |
| `src/tui.test.ts`                 | TUI snapshot resolution, sidebar anchor preservation, command/keybinding registration, deferred prompt-focus retry.                                              |
| `test/helpers/runtime-harness.ts` | Reusable helpers for static event fixtures and fake-time setup.                                                                                                    |
| `test/setup.ts`                   | Global cleanup after each test: timers, mocks, and a minimal set of env vars.                                                                                      |
| `test/fixtures/events/*.json`     | Canonical valid and malformed event payloads used by tests.                                                                                                        |

## Arrange / Act / Assert

Use the **Arrange / Act / Assert** pattern to keep tests readable:

```ts
it("applies a session-created event as a running child", async () => {
  // Arrange
  const state = createEmptyState();
  const event = await readJsonFixture("session-created");

  // Act
  applySubagentEvent(state, event);

  // Assert
  expect(state.children.ses_child_1).toMatchObject({ status: "running" });
});
```

Keep assertions semantic. Prefer checking meaningful counters, titles, statuses, or rendered text over snapshots of large objects.

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
2. Add or extend the co-located test file: `src/events.test.ts`, `src/state.test.ts`, `src/render.test.ts`, `src/reconcile.test.ts`, or another focused unit test such as `src/text-width.test.ts`.
3. Arrange minimal inputs. Reuse existing helpers or fixtures only when they make the test clearer.
4. Act by calling the public function under test.
5. Assert behavior, not implementation details.

Example shape:

```ts
it("does not count tool wrappers as executions", () => {
  const state = createEmptyState();

  upsertRunningChild(state, {
    id: "tool:prt_1",
    title: "Run tests",
    parentID: "ses_parent",
    source: "tool",
  });

  expect(state.totalExecuted).toBe(0);
});
```

If a case depends on time, use `useFrozenTime(...)` from `test/helpers/runtime-harness.ts` or Vitest fake timers directly, and let `test/setup.ts` restore real timers after the test.

## Fixtures

Add new event fixtures under `test/fixtures/events/` when the same payload is useful across tests. Keep fixtures small and representative.

Useful helpers:

- `readJsonFixture(name)` loads `test/fixtures/events/<name>.json`.
- `useFrozenTime(isoTimestamp)` enables fake timers and pins the current time.

## What not to test yet

Do not add deep TUI/e2e automation for `src/tui.tsx` yet. Full OpenCode host automation, visual snapshots, and broad OpenTUI rendering assertions are deferred until the TUI seams are stable.

For now, prefer:

- unit tests for pure formatting, state, and event behavior;
- command/keybinding tests when registration logic changes;
- manual smoke testing in OpenCode when changing the actual TUI surface.

## Troubleshooting and gotchas

### Fake timers

If a test uses fake timers, make sure it is explicit in the Arrange step. `test/setup.ts` calls `vi.useRealTimers()` after each test, but a test should still avoid leaking timer state through shared module-level values.

### Environment variables

The setup file restores the small set of plugin-related env vars after each test. If you add a new env var that tests mutate, add it to `envKeys` in `test/setup.ts`.

### Avoid brittle snapshots

Snapshots can hide intent and break on harmless formatting changes. Prefer focused assertions like:

```ts
expect(state.totalExecuted).toBe(1);
expect(state.children.ses_child_1.title).toBe("Review auth changes");
```

Use snapshots only when the whole rendered shape is the behavior being protected and the output is intentionally stable.
