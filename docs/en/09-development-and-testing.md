# Development and testing

This guide explains how to set up the project locally, which commands to run, and how to think about tests for `opencode-subagent-statusline`.

Practical rule:

> The deterministic core is tested with Vitest. The full UI inside the OpenCode/OpenTUI host is validated with manual smoke tests when visual behavior changes.

## Requirements

The package requires Node.js 24 or newer. Use the pnpm version declared in `package.json` and respect the lockfile.

## Local install

```sh
pnpm install
```

## Main commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build the package with `tsup`. |
| `pnpm dev` | Run `tsup --watch`. |
| `pnpm typecheck` | Run TypeScript checks without emitting files. |
| `pnpm test` | Run the Vitest suite once. |
| `pnpm test:watch` | Run Vitest in watch mode. |
| `pnpm test:coverage` | Generate V8 coverage. |
| `pnpm pack --dry-run` | Simulate the npm package contents. |

Recommended pre-PR checklist:

```sh
pnpm typecheck
pnpm test
pnpm build
```

If packaging or published files changed:

```sh
pnpm pack --dry-run
```

## Build outputs

`tsup.config.ts` builds one TUI bundle:

| Source | Output | Use |
| --- | --- | --- |
| `src/tui.tsx` | `dist/tui.js` + `dist/tui.d.ts` | Supported TUI plugin. |

Both supported package entrypoints resolve to that TUI output:

```txt
opencode-subagent-statusline
opencode-subagent-statusline/tui
```

## TypeScript files

| File | Role |
| --- | --- |
| `tsconfig.json` | Base source config. NodeNext, ES2022, strict, JSX for `@opentui/solid`. |
| `tsconfig.test.json` | Test config for Vitest and setup files. |
| `tsup.config.ts` | Single TUI build config. |

## Test strategy

The project uses Vitest for deterministic unit tests and focused TUI integration seams. Pure projection, descendant discovery, and tree-row tests cover the nested-session behavior without launching a full OpenCode host.

The current full-suite baseline is 351 passing tests across 17 files.

Deep visual TUI E2E automation is intentionally deferred to avoid brittle host-driven tests.

## Test map

| File | Validates |
| --- | --- |
| `src/events.test.ts` | Event parsing, ID extraction, correlation, malformed payload safety. |
| `src/state.test.ts` | State, counters, transitions, pruning, persistence, normalization. |
| `src/render.test.ts` | Text rendering, collapse, visibility, duration, tokens, color/no-color. |
| `src/reconcile.test.ts` | Status normalization, stale-running, backoff, fail-closed behavior. |
| `src/text-width.test.ts` | Terminal column width for CJK/full-width text, combining marks, and truncation. |
| `src/projection.test.ts` | Pure all-depth lineage projection, parent-before-child order, correlation, counters, and cycle safety. |
| `src/tui-descendant-hydration.test.ts` | Iterative bounded descendant discovery, cancellation, fail-closed filtering, and one-batch updates. |
| `src/tui-tree-row.test.ts` | Pure tree-row indentation, narrow-width clamping, labels, and nested navigation targets. |
| `src/tui.test.ts` | TUI lifecycle, persistence, commands, `Alt+B`, keybindings, and integration seams. |
| `src/persistence.test.ts` | Persistence coordination, coalescing, flush behavior, and metadata preservation. |
| `test/helpers/test-harness.ts` | Helpers for isolated temp dirs, fixtures, filesystem checks, and fake time. |
| `test/setup.ts` | Global cleanup for timers, mocks, env vars, and temp dirs. |
| `test/package-contract.test.ts` | Root and `/tui` exports plus absence of removed source and build artifacts. |

## Coverage

Configured in `vitest.config.ts`:

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "lcov"],
  include: ["src/**/*.ts"],
  exclude: ["src/**/*.test.ts", "src/tui.tsx"],
}
```

Important:

> `src/tui.tsx` is excluded from coverage. Do not claim the complete visual TUI is automatically covered.

Coverage focuses on deterministic `.ts` modules: events, state, projection, render, reconcile, text width helpers, commands, discovery, and tree rows.

## Arrange / Act / Assert

Tests should follow this structure:

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

Prefer semantic assertions over large snapshots.

Good:

```ts
expect(output).toContain("1 running");
expect(output).toContain("Review auth changes");
```

More brittle:

```ts
expect(output).toMatchSnapshot();
```

## Adding a unit test

1. Identify the behavior to protect.
2. Pick the colocated test file:
   - `src/events.test.ts`
   - `src/state.test.ts`
   - `src/render.test.ts`
   - `src/reconcile.test.ts`
   - `src/tui.test.ts`
3. Build minimal inputs.
4. Call the public function or helper under test.
5. Assert visible behavior, not accidental implementation detail.

Conceptual example:

```ts
it("does not count tool wrappers", () => {
  const state = createEmptyState();

  upsertRunningChild(state, {
    id: "tool:prt_1",
    source: "tool",
  });

  expect(state.totalExecuted).toBe(0);
});
```

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

| Helper | Use |
| --- | --- |
| `createFileHarness()` | Creates a temp dir and isolated state/text paths. |
| `readJsonFixture(name)` | Reads `test/fixtures/events/<name>.json`. |
| `pathExists(path)` | Checks existence without throwing. |
| `useFrozenTime(iso)` | Freezes time with fake timers. |

## Fixtures

Fixtures live in:

```txt
test/fixtures/events/
```

Keep them small and representative. Avoid huge dumps unless payload size is part of the behavior under test.

## Fake timers

For time-dependent tests:

- freeze time explicitly in Arrange;
- avoid shared global state;
- let `test/setup.ts` restore real timers after the test.

```ts
useFrozenTime("2026-01-01T00:00:00.000Z");
```

## Test environment variables

`test/setup.ts` restores plugin env vars after each test.

If a new env var is mutated by tests, add it to the cleanup list in `test/setup.ts`.

## What not to test yet

Do not add deep automation yet for:

- full OpenTUI visual snapshots;
- complete host-driven OpenCode navigation;
- broad E2E over `src/tui.tsx`.

For real UI changes, prefer:

1. unit tests for extractable logic;
2. command tests if registration/keybindings changed;
3. manual OpenCode smoke test.

## Manual TUI smoke test

When changing `src/tui.tsx`, `src/render.ts`, or visible behavior:

1. Build:

   ```sh
   pnpm build
   ```

2. Configure OpenCode with an absolute path:

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["/absolute/path/to/sub-agent-statusline/dist/tui.js"]
   }
   ```

3. Restart OpenCode.
4. Run a delegation/subagent.
5. Verify descendants at every depth, parent-before-child order, statuses, and duration.
6. Test `Alt+B`, `j/k`, arrows, `Enter`, and `Esc`.
7. If token/context data exists, confirm it does not break the row.
8. Check logs if the plugin does not load.

## CI

PR workflow: `.github/workflows/ci.yml`.

It runs:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

It does not run `pnpm build` or `pnpm pack --dry-run`.

If your change touches build, package exports, published assets, or `package.json.files`, run those commands manually.

## Contribution practices

From `CONTRIBUTING.md`:

- prefer issue-first for non-trivial changes;
- keep PRs small and reviewable;
- use Conventional Commits;
- never commit secrets;
- explain what changed, why, and how it was validated.

Example commits:

```txt
feat: add nested session rows
fix: handle missing token metadata
docs: clarify local setup
```

## Quick checklist by change type

| Change | Minimum recommended validation |
| --- | --- |
| Docs only | Check links and Markdown formatting. |
| Events/state/render | `pnpm test`, focused tests. |
| TypeScript/API | `pnpm typecheck`, `pnpm test`. |
| Visual TUI | `pnpm build`, manual OpenCode smoke test. |
| Packaging | `pnpm build`, `pnpm pack --dry-run`. |
| CI/release | Review workflows and document impact. |
