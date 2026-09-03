import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { describe, expect, it, vi } from "vitest";

const fsMockState = vi.hoisted(() => {
  const appendDescriptors: number[] = [];
  const closeDescriptors: number[] = [];
  const lifecycle: Array<"append" | "close"> = [];
  return {
    appendShouldThrow: false,
    appendCalls: 0,
    appendDescriptors,
    closeDescriptors,
    lifecycle,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
      fsMockState.appendCalls += 1;
      fsMockState.lifecycle.push("append");
      const descriptor = args[0];
      if (typeof descriptor === "number") {
        fsMockState.appendDescriptors.push(descriptor);
      }
      if (fsMockState.appendShouldThrow) {
        throw new Error("append failed");
      }
      return actual.appendFileSync(...args);
    },
    closeSync: (descriptor: Parameters<typeof actual.closeSync>[0]) => {
      fsMockState.lifecycle.push("close");
      fsMockState.closeDescriptors.push(descriptor);
      return actual.closeSync(descriptor);
    },
  };
});

import {
  backfillHydratedTargetSessionIDs,
  activateSubagentTreeRow,
  __tuiInitializeForTests,
  combineTuiPersistenceSnapshots,
  formatChildRowLine,
  formatChildModelLine,
  formatTerminalChildRowLine,
  hydratePreviousSubagents,
  prioritizeTokenHydrationCandidates,
  preservedSidebarAnchorScrollTop,
  preservedSidebarScrollTop,
  resolveSidebarSubagentSnapshot,
  probeRunningEvidence,
  selectRunningReconcileCandidates,
  persistStateSnapshot,
  resolveTuiSubagentSnapshot,
  subagentRowHeight,
  wrapCompactText,
  type RouteHydrationApi,
  type TuiPersistenceSnapshot,
} from "./tui.js";
import {
  createTokenHydrationQueue,
  mergeFreshHydratedTokens,
  ROUTE_CHILD_MESSAGE_CONCURRENCY,
  ROUTE_CHILD_MESSAGE_LIMIT,
  scheduleHydrateRetry,
  TOKEN_HYDRATION_ADMISSION_LIMIT,
} from "./tui-hydration.js";
import { textColumns } from "./text-width.js";
import { renderStatusLine } from "./render.js";
import {
  createManagedDeferredCallbacks,
  focusPromptWithDeferredRetry,
  resolveSidebarReturnFocusAction,
  resolveSiblingSidebarRefocus,
  shouldReleaseSidebarListFocus,
} from "./tui-focus.js";
import {
  activateSidebarSelection,
  buildSidebarRowLayoutIndex,
  moveSidebarRowSelection,
  resolveSidebarRowWindow,
  resolveSidebarSelectedRowID,
} from "./tui-row-window.js";
import {
  createBestEffortDisposer,
  registerSubagentCommands,
} from "./tui-commands.js";
import {
  saveState,
  saveStatusText,
  type ChildSessionState,
  type StatuslineState,
} from "./state.js";
import { createPersistenceCoordinator } from "./persistence.js";
import {
  buildCurrentRouteSubtreeProjection,
  createCurrentRouteSubtreeCoordinator,
} from "./tui-route-subtree.js";
import * as treeRowGeometry from "./tui-tree-row.js";
import {
  createFileHarness,
  pathExists,
} from "../test/helpers/test-harness.js";

type RegisterSubagentCommandsInput = Parameters<
  typeof registerSubagentCommands
>[0];
type KeymapLayer = Parameters<
  NonNullable<
    NonNullable<RegisterSubagentCommandsInput["api"]["keymap"]>["registerLayer"]
  >
>[0];
type LegacyCommandFactory = Parameters<
  NonNullable<
    NonNullable<RegisterSubagentCommandsInput["api"]["command"]>["register"]
  >
>[0];

function child(overrides: Partial<ChildSessionState> = {}): ChildSessionState {
  return {
    id: "ses_child",
    title: "Child work",
    parentID: "ses_parent",
    source: "session",
    targetSessionID: "ses_child",
    status: "running",
    color: "yellow",
    startedAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:01:00.000Z",
    ...overrides,
  };
}

function stateWith(
  children: ChildSessionState[],
  countedChildIDs = children
    .filter((item) => item.source === "session" || item.id.startsWith("ses_"))
    .map((item) => item.targetSessionID ?? item.id),
): StatuslineState {
  return {
    children: Object.fromEntries(children.map((item) => [item.id, item])),
    countedChildIDs: Object.fromEntries(
      countedChildIDs.map((id) => [id, true]),
    ),
    totalExecuted: 99,
    updatedAt: "2026-04-30T10:20:00.000Z",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const createHydrationApi = (input: {
  readonly directory: string;
  readonly graph: Readonly<Record<string, readonly unknown[]>>;
  readonly statuses?: Readonly<Record<string, unknown>>;
  readonly messages?: Readonly<Record<string, readonly unknown[]>>;
}): {
  readonly api: RouteHydrationApi;
  readonly children: ReturnType<typeof vi.fn>;
  readonly messages: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
} => {
  const children = vi.fn(
    async ({ sessionID }: { readonly sessionID: string }) => ({
      data: input.graph[sessionID] ?? [],
    }),
  );
  const messages = vi.fn(
    async ({ sessionID }: { readonly sessionID: string }) => ({
      data: input.messages?.[sessionID] ?? [],
    }),
  );
  const status = vi.fn(async () => ({ data: input.statuses ?? {} }));
  const api: RouteHydrationApi = {
    state: { path: { directory: input.directory } },
    client: { session: { children, messages, status } },
  };
  return { api, children, messages, status };
};

async function hydrateState(input: {
  children: unknown[];
  parentMessages?: unknown[];
  childMessages?: Record<string, unknown[]>;
  statuses?: Record<string, unknown>;
}): Promise<StatuslineState> {
  let state = stateWith([]);
  const dir = await mkdtemp(join(tmpdir(), "subagent-statusline-hydrate-"));
  const childMessages = input.childMessages ?? {};
  const hydratedChildren = input.children.map((row) =>
    typeof row === "object" && row !== null
      ? { directory: dir, ...row }
      : row,
  );
  const api: RouteHydrationApi = {
    state: { path: { directory: dir } },
    client: {
      session: {
        children: vi.fn(
          async ({ sessionID }: { readonly sessionID: string }) => ({
            data: sessionID === "ses_parent" ? hydratedChildren : [],
          }),
        ),
        messages: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
          data:
            sessionID === "ses_parent"
              ? (input.parentMessages ?? [])
              : (childMessages[sessionID] ?? []),
        })),
        status: vi.fn(async () => ({ data: input.statuses ?? {} })),
      },
    },
  };

  await hydratePreviousSubagents({
    api,
    currentSessionID: "ses_parent",
    statePath: join(dir, "state.json"),
    textPath: join(dir, "status.txt"),
    setState: (update) => {
      state = update(state);
    },
  });

  return state;
}

type CapturedTuiEventHandler = (event: unknown) => Promise<void>;

function initializeTuiForTokenHydration(input: {
  readonly directory: string;
  readonly session: {
    readonly status?: (sessionID: string) => unknown;
    readonly messages?: (sessionID: string) => readonly unknown[];
  };
  readonly part: (messageID: string) => readonly unknown[];
  readonly clientMessages: () => Promise<{
    readonly data: readonly unknown[];
  }>;
}): {
  readonly handler: (name: string) => CapturedTuiEventHandler;
  readonly dispose: () => void;
} {
  const handlers = new Map<string, CapturedTuiEventHandler>();
  const lifecycleController = new AbortController();
  let disposeTui = (): void => undefined;
  const sessionState = {
    get: (sessionID: string) =>
      sessionID === "ses_parent" ? { directory: input.directory } : undefined,
    ...(input.session.status ? { status: input.session.status } : {}),
    ...(input.session.messages ? { messages: input.session.messages } : {}),
  };
  const api = {
    app: { version: "test" },
    kv: {
      get: <Value>(_key: string, fallback: Value): Value => fallback,
      set: () => undefined,
    },
    lifecycle: {
      signal: lifecycleController.signal,
      onDispose: (callback: () => void) => {
        disposeTui = callback;
        return () => undefined;
      },
    },
    route: { current: { name: "home" } },
    state: {
      path: { directory: input.directory },
      session: sessionState,
      part: input.part,
    },
    client: { session: { messages: input.clientMessages } },
    event: {
      on: (name: string, handler: CapturedTuiEventHandler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
    },
    slots: { register: () => undefined },
  } as unknown as TuiPluginApi;

  __tuiInitializeForTests(api, () => undefined);

  return {
    handler(name) {
      const handler = handlers.get(name);
      if (!handler) {
        throw new TypeError(`TUI event handler was not registered: ${name}`);
      }
      return handler;
    },
    dispose() {
      disposeTui();
      lifecycleController.abort();
    },
  };
}

describe("TUI subagent snapshots", () => {
  it("enumerates scoped children exactly once", () => {
    // Given
    let enumerations = 0;
    const base = stateWith([
      child({ id: "ses_child", parentID: "ses_root" }),
    ]);
    const children = new Proxy(base.children, {
      ownKeys(target) {
        enumerations += 1;
        return Reflect.ownKeys(target);
      },
    });

    // When
    resolveTuiSubagentSnapshot({
      state: { ...base, children },
      sessionID: "ses_root",
    });

    // Then
    expect(enumerations).toBe(1);
  });

  it("reuses the current route subtree for repeated sidebar snapshots", () => {
    // Given
    let enumerations = 0;
    const base = stateWith([
      child({ id: "ses_child", parentID: "ses_root" }),
    ]);
    const state = {
      ...base,
      children: new Proxy(base.children, {
        ownKeys(target) {
          enumerations += 1;
          return Reflect.ownKeys(target);
        },
      }),
    };
    const currentRouteProjection = buildCurrentRouteSubtreeProjection(
      state,
      "ses_root",
    );

    // When
    const first = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_root",
      currentRouteProjection,
    });
    const second = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_root",
      currentRouteProjection,
      showCompletedHistory: true,
    });

    // Then
    expect(first.descendantSessionIDs).toBe(second.descendantSessionIDs);
    expect(enumerations).toBe(1);
  });

  it("returns every canonical descendant with depth and scoped counts", () => {
    // Given
    const state = stateWith([
      child({
        id: "ses_child",
        parentID: "ses_root",
        status: "running",
        tokens: { total: 9 },
        model: { providerID: "openai", modelID: "gpt", variant: "high" },
      }),
      child({
        id: "ses_grand",
        parentID: "ses_child",
        targetSessionID: "ses_grand",
        status: "done",
        color: "green",
      }),
      child({
        id: "ses_deep",
        parentID: "ses_grand",
        targetSessionID: "ses_deep",
        status: "error",
        color: "red",
      }),
      child({
        id: "tool:proxy",
        source: "tool",
        parentID: "ses_child",
        targetSessionID: "ses_grand",
      }),
      child({
        id: "tool:wrapper",
        source: "tool",
        parentID: "ses_grand",
        targetSessionID: undefined,
      }),
      child({
        id: "ses_other",
        parentID: "ses_other_root",
        targetSessionID: "ses_other",
      }),
    ]);

    // When
    const snapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_root",
      showCompletedHistory: true,
    });

    // Then
    expect(
      snapshot.visibleRows.map(({ child: row, depth }) => [row.id, depth]),
    ).toEqual([
      ["ses_child", 0],
      ["ses_grand", 1],
      ["ses_deep", 2],
    ]);
    expect(snapshot.visibleRows[0]?.child.tokens).toEqual({ total: 9 });
    expect(snapshot.visibleRows[0]?.child.model?.variant).toBe("high");
    expect(snapshot.visibleCounts).toEqual({ running: 1, done: 1, error: 1 });
    expect(snapshot.totalExecuted).toBe(3);
    expect(snapshot.descendantSessionIDs).toEqual(
      new Set(["ses_child", "ses_grand", "ses_deep"]),
    );
  });

  it("keeps global home semantics while sidebar totals include descendants once", () => {
    // Given
    const state = stateWith(
      [
        child({
          id: "ses_child",
          parentID: "ses_root",
          targetSessionID: "ses_child",
        }),
        child({
          id: "ses_grand",
          parentID: "ses_child",
          targetSessionID: "ses_grand",
        }),
        child({
          id: "ses_other",
          parentID: "ses_other_root",
          targetSessionID: "ses_other",
        }),
      ],
      ["ses_child", "ses_grand", "ses_other"],
    );

    // When
    const sidebar = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_root",
    });
    const home = resolveTuiSubagentSnapshot({ state });

    // Then
    expect(sidebar.totalExecuted).toBe(2);
    expect(home.totalExecuted).toBe(3);
    expect(home.visibleRows.every(({ depth }) => depth === 0)).toBe(true);
  });

  it("keeps terminal TUI persistence pending until paired JSON/text writes finish", async () => {
    const writerCompletion = deferred<void>();
    const writes: string[] = [];
    const queuedSnapshots: TuiPersistenceSnapshot[] = [];
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async (snapshot) => {
        queuedSnapshots.push(snapshot);
        writes.push("json");
        await writerCompletion.promise;
        writes.push("text");
      },
    );

    const state = stateWith([child({ status: "error" })]);
    const completion = persistStateSnapshot(
      persistence,
      state,
      true,
      ["ses_child"],
    );
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(writes).toEqual(["json"]);

    writerCompletion.resolve(undefined);
    await completion;

    expect(writes).toEqual(["json", "text"]);
    expect(queuedSnapshots).toEqual([
      { state, changedChildIDs: ["ses_child"] },
    ]);
    persistence.close();
  });

  it("combines changed-child IDs deterministically while keeping the newest state", () => {
    const previousState = stateWith([child({ id: "ses_a" })]);
    const newestState = stateWith([child({ id: "ses_b" })]);

    expect(
      combineTuiPersistenceSnapshots(
        { state: previousState, changedChildIDs: ["ses_a", "ses_shared"] },
        { state: newestState, changedChildIDs: ["ses_shared", "ses_b"] },
      ),
    ).toEqual({
      state: newestState,
      changedChildIDs: ["ses_a", "ses_shared", "ses_b"],
    });
  });

  it("lets a full-refresh snapshot dominate finite changed-child IDs", () => {
    const previousState = stateWith([child({ id: "ses_a" })]);
    const newestState = stateWith([child({ id: "ses_b" })]);

    expect(
      combineTuiPersistenceSnapshots(
        { state: previousState },
        { state: newestState, changedChildIDs: ["ses_b"] },
      ),
    ).toEqual({ state: newestState });
    expect(
      combineTuiPersistenceSnapshots(
        { state: previousState, changedChildIDs: ["ses_a"] },
        { state: newestState },
      ),
    ).toEqual({ state: newestState });
  });

  it("keeps live state unchanged when coalesced TUI snapshots are persisted", async () => {
    // Given
    const harness = await createFileHarness();
    const newestState = stateWith([
      child({
        id: "ses_a",
        targetSessionID: "ses_a",
        status: "running",
        color: "red",
      }),
      child({
        id: "ses_b",
        targetSessionID: "ses_b",
        status: "running",
        color: "green",
      }),
    ]);
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ state, changedChildIDs }) => {
        await saveState(harness.statePath, state, { changedChildIDs });
      },
      { settleDelayMs: 20, combineSnapshots: combineTuiPersistenceSnapshots },
    );
    const routeProjection = createCurrentRouteSubtreeCoordinator();
    routeProjection.read({ state: newestState, sessionID: "ses_parent" });

    // When
    const first = persistStateSnapshot(persistence, newestState, false, [
      "ses_a",
    ]);
    const second = persistStateSnapshot(persistence, newestState, false, [
      "ses_b",
    ]);
    await Promise.all([first, second]);
    const cachedProjection = routeProjection.read({
      state: newestState,
      sessionID: "ses_parent",
    });

    // Then
    const persisted: unknown = JSON.parse(
      await readFile(harness.statePath, "utf8"),
    );
    expect(persisted).toMatchObject({
      children: {
        ses_a: { status: "running", color: "yellow" },
        ses_b: { status: "running", color: "yellow" },
      },
    });
    expect
      .soft(cachedProjection?.subtree.canonicalRows.map(({ color }) => color))
      .toEqual(Object.values(newestState.children).map(({ color }) => color));
    expect(newestState.children).toMatchObject({
      ses_a: { status: "running", color: "red" },
      ses_b: { status: "running", color: "green" },
    });
    persistence.close();
  });

  it("isolates an earlier writer generation from a mutated replacement state", async () => {
    // Given
    const harness = await createFileHarness();
    const firstWriter = deferred<void>();
    const stateA = stateWith([
      child({
        id: "ses_a",
        title: "State A",
        targetSessionID: "ses_a",
        tokens: { input: 1, output: 2 },
        model: { providerID: "provider-a", modelID: "model-a", variant: "a" },
        color: "red",
      }),
    ]);
    const stateB = stateWith([
      child({
        id: "ses_b",
        title: "State B",
        targetSessionID: "ses_b",
        tokens: { input: 3, output: 4 },
        model: { providerID: "provider-b", modelID: "model-b", variant: "b" },
      }),
    ]);
    const preparedStates: StatuslineState[] = [];
    const changedSnapshots: Array<readonly string[] | undefined> = [];
    let writerCount = 0;
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ state, changedChildIDs }) => {
        const currentWriter = writerCount;
        writerCount += 1;
        if (currentWriter === 0) await firstWriter.promise;
        const prepared = await saveState(
          join(harness.dir, `state-${currentWriter}.json`),
          state,
          { ...(changedChildIDs !== undefined ? { changedChildIDs } : {}) },
        );
        preparedStates.push(prepared);
        changedSnapshots.push(changedChildIDs);
      },
    );

    // When
    const first = persistStateSnapshot(persistence, stateA, false, ["ses_a"]);
    await Promise.resolve();
    const replacementIDs = ["ses_b"];
    const second = persistStateSnapshot(
      persistence,
      stateB,
      false,
      replacementIDs,
    );
    replacementIDs.push("mutated-after-enqueue");
    const replacementChild = stateB.children.ses_b;
    if (!replacementChild) throw new TypeError("replacement child is missing");
    replacementChild.tokens = { input: 30, output: 40, contextPercent: 50 };
    replacementChild.model = {
      providerID: "mutated-provider",
      modelID: "mutated-model",
      variant: "mutated",
    };
    firstWriter.resolve(undefined);
    await Promise.all([first, second]);

    // Then
    expect(preparedStates).toHaveLength(2);
    expect(changedSnapshots).toEqual([["ses_a"], ["ses_b"]]);
    const firstPrepared = preparedStates[0];
    const secondPrepared = preparedStates[1];
    if (!firstPrepared || !secondPrepared) {
      throw new TypeError("both persistence generations should be prepared");
    }
    expect(firstPrepared.children.ses_a).toMatchObject({
      tokens: { input: 1, output: 2 },
      model: { providerID: "provider-a", modelID: "model-a", variant: "a" },
    });
    expect(secondPrepared.children.ses_b).toMatchObject({
      tokens: { input: 30, output: 40, contextPercent: 50 },
      model: {
        providerID: "mutated-provider",
        modelID: "mutated-model",
        variant: "mutated",
      },
    });
    expect(stateA.children.ses_a).toMatchObject({
      tokens: { input: 1, output: 2 },
      model: { providerID: "provider-a", modelID: "model-a", variant: "a" },
    });
    persistence.close();
  });

  it("writes JSON and status text from the same normalized snapshot", async () => {
    // Given
    const harness = await createFileHarness();
    const nowMs = Date.now();
    const startedAt = new Date(nowMs - 120_000).toISOString();
    const endedAt = new Date(nowMs - 60_000).toISOString();
    const state = stateWith([
      child({
        id: "ses_child",
        title: "Normalized worker",
        status: "done",
        color: "red",
        startedAt,
        updatedAt: endedAt,
        endedAt,
        tokens: { input: 100, output: 50, contextPercent: 12.5 },
        model: {
          providerID: " openai ",
          modelID: " gpt-5.6 ",
          variant: " high ",
        },
      }),
    ]);
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ state: queuedState, changedChildIDs }) => {
        const prepared = await saveState(harness.statePath, queuedState, {
          ...(changedChildIDs !== undefined ? { changedChildIDs } : {}),
        });
        await saveStatusText(harness.textPath, renderStatusLine(prepared));
      },
    );

    // When
    await persistStateSnapshot(persistence, state, true, ["ses_child"]);

    // Then
    const persisted: unknown = JSON.parse(
      await readFile(harness.statePath, "utf8"),
    );
    const text = await readFile(harness.textPath, "utf8");
    expect(persisted).toMatchObject({
      children: {
        ses_child: {
          color: "green",
          elapsedMs: 60_000,
          model: {
            providerID: "openai",
            modelID: "gpt-5.6",
            variant: "high",
          },
        },
      },
    });
    expect(text).toContain("Normalized worker 01:00");
    expect(text).toContain("150 tokens");
    persistence.close();
  });

  it("surfaces saveState writer failures to the coordinator caller", async () => {
    // Given
    const harness = await createFileHarness();
    const state = stateWith([child({ id: "ses_fail", title: "Fail" })]);
    const writerError = new Error("disk full");
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async () => {
        throw writerError;
      },
    );

    // When / Then
    await expect(
      persistStateSnapshot(persistence, state, true, ["ses_fail"]),
    ).rejects.toBe(writerError);
    persistence.close();
  });

  it("retries an unchanged status text after a transient write failure", async () => {
    // Given
    const harness = await createFileHarness();
    await mkdir(harness.textPath);
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void>
    >();
    const lifecycleController = new AbortController();
    let dispose: () => void = () => undefined;
    const api = {
      kv: {
        get: <Value>(_key: string, fallback: Value): Value => fallback,
        set: () => undefined,
      },
      lifecycle: {
        signal: lifecycleController.signal,
        onDispose: (callback: () => void) => {
          dispose = callback;
        },
      },
      route: { current: { name: "home" } },
      state: { path: { directory: harness.dir } },
      client: {},
      event: {
        on: (name: string, handler: (event: unknown) => Promise<void>) => {
          handlers.set(name, handler);
          return () => handlers.delete(name);
        },
      },
      slots: { register: () => undefined },
    } as unknown as TuiPluginApi;
    __tuiInitializeForTests(api, () => undefined);
    lifecycleController.abort();
    const applySessionUpdate = handlers.get("session.updated");
    if (!applySessionUpdate) {
      throw new TypeError("session.updated handler was not registered");
    }

    // When
    await applySessionUpdate({
      type: "session.updated",
      properties: {
        sessionID: "ses_child",
        info: {
          id: "ses_child",
          parentID: "ses_parent",
          directory: harness.dir,
          title: "Initial title",
          status: "idle",
          time: { updated: "2026-09-03T04:00:00.000Z" },
        },
      },
    });
    await rm(harness.textPath, { recursive: true });
    await applySessionUpdate({
      type: "session.updated",
      properties: {
        sessionID: "ses_child",
        info: {
          id: "ses_child",
          parentID: "ses_parent",
          directory: harness.dir,
          title: "Updated title",
          status: "idle",
          time: { updated: "2026-09-03T04:01:00.000Z" },
        },
      },
    });
    dispose();

    // Then
    expect(await pathExists(harness.textPath)).toBe(true);
    expect(await readFile(harness.textPath, "utf8")).not.toBe("");
  });

  it("wraps unbroken Japanese text within odd terminal column budgets", () => {
    const lines = wrapCompactText("日本語の概要を表示しています追加確認", 25, 2);

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => textColumns(line) <= 25)).toBe(true);
  });

  it("truncates unbroken Japanese text within narrow terminal column budgets", () => {
    const lines = wrapCompactText("日本語の概要を表示しています", 8, 2);

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => textColumns(line) <= 8)).toBe(true);
  });

  it("matches running row height to rendered secondary-line presence", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");

    expect(
      subagentRowHeight({ child: child({ title: "Short task" }), nowMs }),
    ).toBe(2);
    expect(
      subagentRowHeight({
        child: child({ title: "Short task", agentName: "reviewer" }),
        nowMs,
      }),
    ).toBe(3);
    expect(
      subagentRowHeight({
        child: child({ title: "Short task", status: "done" }),
        nowMs,
      }),
    ).toBe(2);
  });

  it("matches nested row height to the post-indent display width", () => {
    // Given
    const input = {
      child: child({
        title: "A deliberately long nested task title that must wrap",
        agentName: "reviewer",
      }),
      depth: 100,
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
      sidebarWidth: 12,
      reservedWidth: 4,
    };

    // When
    const line = formatChildRowLine(input);
    const height = subagentRowHeight(input);

    // Then
    expect(line.labelWidth).toBe(8);
    expect(
      line.labelLines.every((value) => textColumns(value) <= line.labelWidth),
    ).toBe(true);
    expect(
      line.secondaryLine === undefined ||
        textColumns(line.secondaryLine) <= line.labelWidth,
    ).toBe(true);
    expect(height).toBe(line.secondaryLine ? 3 : 2);
  });

  it("keeps every deep row line family inside the assembled row width", () => {
    // Given
    const rowWidth = 24;
    const exportedPrefixColumns = Reflect.get(
      treeRowGeometry,
      "SUBAGENT_TREE_ROW_PREFIX_COLUMNS",
    );
    const prefixColumns =
      typeof exportedPrefixColumns === "number" ? exportedPrefixColumns : 4;
    const geometry = treeRowGeometry.resolveTreeRowLayout({
      depth: 100,
      rowWidth,
      fixedColumns: prefixColumns,
      minimumLabelWidth: 8,
    });
    const providers: TuiPluginApi["state"]["provider"] = [];
    const runningInput = {
      child: child({
        title: "ABCDEFGHIJKLMNOPQR",
        tokens: { total: 9_999_999, contextPercent: 100 },
        model: {
          providerID: "openai",
          modelID: "ABCDEFGHIJKLM",
          variant: "maximum",
        },
      }),
      depth: 100,
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
      sidebarWidth: 28,
      reservedWidth: prefixColumns,
    };
    const terminalInput = {
      ...runningInput,
      child: child({
        title: "ABCDEFGHIJKLMNOPQR",
        status: "done",
        tokens: { total: 9_999_999, contextPercent: 100 },
        model: {
          providerID: "openai",
          modelID: "ABCDEFGHIJKLM",
          variant: "maximum",
        },
      }),
    };

    // When
    const running = formatChildRowLine(runningInput);
    const terminal = formatTerminalChildRowLine(terminalInput);
    const indent = " ".repeat(geometry.indentColumns);
    const continuationPrefix = " ".repeat(prefixColumns);
    const runningModel = formatChildModelLine(
      runningInput.child,
      providers,
      running.labelWidth,
    );
    const terminalModel = formatChildModelLine(
      terminalInput.child,
      providers,
      geometry.labelWidth,
    );
    const runningLines = [
      `${indent} [ ] ${running.labelLines[0] ?? ""}`,
      ...(running.secondaryLine
        ? [`${indent}${continuationPrefix}${running.secondaryLine}`]
        : []),
      `${indent}${continuationPrefix}${running.detailLine}`,
      ...(runningModel
        ? [`${indent}${continuationPrefix}${runningModel}`]
        : []),
    ];
    const terminalLines = [
      `${indent} [✓] ${terminal.label}`,
      `${indent}${continuationPrefix}${terminal.detailLine}`,
      ...(terminalModel
        ? [`${indent}${continuationPrefix}${terminalModel}`]
        : []),
    ];

    // Then
    expect(running.labelLines[0]).toHaveLength(running.labelWidth);
    expect(running.secondaryLine).toHaveLength(running.labelWidth);
    expect(running.detailLine).toHaveLength(running.labelWidth);
    expect(runningModel).toHaveLength(running.labelWidth);
    expect(terminal.label).toHaveLength(geometry.labelWidth);
    expect(terminal.detailLine).toHaveLength(geometry.labelWidth);
    expect(terminalModel).toHaveLength(geometry.labelWidth);
    const assembledWidths = [...runningLines, ...terminalLines].map(textColumns);
    expect(Math.max(...assembledWidths)).toBeLessThanOrEqual(rowWidth);
    expect(exportedPrefixColumns).toBe(5);
    expect(subagentRowHeight(runningInput)).toBe(runningLines.length);
    expect(subagentRowHeight(terminalInput)).toBe(terminalLines.length);
  });

  it("bounds a standalone CJK agent parenthetical inside the deep row width", () => {
    // Given
    const rowWidth = 24;
    const prefixColumns = treeRowGeometry.SUBAGENT_TREE_ROW_PREFIX_COLUMNS;
    const input = {
      child: child({
        title: "短い",
        agentName: "超長型エージェント識別名称",
      }),
      depth: 100,
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
      sidebarWidth: 28,
      reservedWidth: prefixColumns,
    };
    const geometry = treeRowGeometry.resolveTreeRowLayout({
      depth: input.depth,
      rowWidth,
      fixedColumns: prefixColumns,
      minimumLabelWidth: 8,
    });

    // When
    const line = formatChildRowLine(input);
    if (line.secondaryLine === undefined) {
      throw new Error("expected standalone agent parenthetical");
    }
    const indent = " ".repeat(geometry.indentColumns);
    const continuationPrefix = " ".repeat(prefixColumns);
    const renderedLines = [
      `${indent} [ ] ${line.labelLines[0] ?? ""}`,
      `${indent}${continuationPrefix}${line.secondaryLine}`,
      `${indent}${continuationPrefix}${line.detailLine}`,
    ];

    // Then
    expect(textColumns(line.secondaryLine)).toBeLessThanOrEqual(line.labelWidth);
    expect(Math.max(...renderedLines.map(textColumns))).toBeLessThanOrEqual(rowWidth);
    expect(subagentRowHeight(input)).toBe(renderedLines.length);
  });

  it("keeps a family emoji atomic in a deep row and matches rendered height", () => {
    // Given
    const rowWidth = 13;
    const prefixColumns = treeRowGeometry.SUBAGENT_TREE_ROW_PREFIX_COLUMNS;
    const input = {
      child: child({ title: "123456👨‍👩‍👧‍👦x" }),
      depth: 100,
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
      sidebarWidth: 17,
      reservedWidth: prefixColumns,
    };
    const geometry = treeRowGeometry.resolveTreeRowLayout({
      depth: input.depth,
      rowWidth,
      fixedColumns: prefixColumns,
      minimumLabelWidth: 8,
    });

    // When
    const line = formatChildRowLine(input);
    const indent = " ".repeat(geometry.indentColumns);
    const continuationPrefix = " ".repeat(prefixColumns);
    const renderedLines = [
      `${indent} [ ] ${line.labelLines[0] ?? ""}`,
      ...(line.secondaryLine
        ? [`${indent}${continuationPrefix}${line.secondaryLine}`]
        : []),
      `${indent}${continuationPrefix}${line.detailLine}`,
    ];

    // Then
    expect(line.labelLines[0]).toBe("123456👨‍👩‍👧‍👦");
    expect(Math.max(...renderedLines.map(textColumns))).toBeLessThanOrEqual(
      rowWidth,
    );
    expect(subagentRowHeight(input)).toBe(renderedLines.length);
  });

  it("shows model metadata only with a variant and accounts for layout height", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const plain = child({ title: "Short task" });
    const modeled = child({
      title: "Short task",
      model: { providerID: "openai", modelID: "gpt-5.6", variant: "high" },
    });
    const providers = [{
      id: "openai",
      models: { "gpt-5.6": { name: "GPT 5.6" } },
    }] as unknown as TuiPluginApi["state"]["provider"];

    expect(formatChildModelLine(plain, providers, 20)).toBeUndefined();
    expect(
      formatChildModelLine(
        child({ model: { providerID: "openai", modelID: "gpt-5.6" } }),
        providers,
        20,
      ),
    ).toBeUndefined();
    expect(subagentRowHeight({ child: plain, nowMs })).toBe(2);
    expect(formatChildModelLine(modeled, providers, 20)).toBe("GPT 5.6 · high");
    expect(subagentRowHeight({ child: modeled, nowMs })).toBe(3);
    expect(
      formatChildModelLine(
        child({ model: { providerID: "missing", modelID: "長いモデル識別子", variant: "最大" } }),
        providers,
        12,
      ),
    ).toSatisfy((line: string | undefined) => !!line && textColumns(line) <= 12);
    expect(
      formatChildModelLine(
        child({ model: { providerID: "missing", modelID: "fallback-model", variant: "fast" } }),
        providers,
        40,
      ),
    ).toBe("fallback-model · fast");
  });

  it("bounds mounted rows for near-cap logical history without dropping logical IDs", () => {
    // Given
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const retained = Array.from({ length: 1_498 }, (_, index) =>
      child({
        id: `ses_history_${index.toString().padStart(4, "0")}`,
        targetSessionID: `ses_history_${index.toString().padStart(4, "0")}`,
        messageID: `msg_history_${index}`,
        status: index % 11 === 0 ? "error" : "done",
        color: index % 11 === 0 ? "red" : "green",
        endedAt: "2026-04-29T10:00:00.000Z",
        updatedAt: "2026-04-29T10:00:00.000Z",
        model:
          index % 7 === 0
            ? { providerID: "openai", modelID: "gpt-5.6", variant: "high" }
            : undefined,
      }),
    );
    const snapshot = resolveSidebarSubagentSnapshot({
      state: stateWith(retained),
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });
    const layout = buildSidebarRowLayoutIndex(
      snapshot.visibleRows.map(({ child: item }) => ({
        id: item.id,
        height: subagentRowHeight({ child: item, nowMs }),
      })),
      0,
    );

    // When
    const window = resolveSidebarRowWindow(
      layout,
      layout.contentHeight - 20,
      20,
    );

    // Then
    expect(snapshot.visibleRows).toHaveLength(1_498);
    expect(layout.rows).toHaveLength(1_498);
    expect(window.rows.length).toBeLessThanOrEqual(14);
    expect(window.rows.at(-1)?.id).toBe("ses_history_1497");
    expect(
      window.beforeHeight +
        window.rows.reduce((height, row) => height + row.height, 0) +
        window.afterHeight,
    ).toBe(layout.contentHeight);
  });

  it("indexes mixed row heights with prefix offsets and fixed boundary overscan", () => {
    // Given
    const layout = buildSidebarRowLayoutIndex(
      [
        { id: "a", height: 2 },
        { id: "b", height: 4 },
        { id: "c", height: 3 },
        { id: "d", height: 2 },
        { id: "e", height: 4 },
        { id: "f", height: 2 },
        { id: "g", height: 3 },
      ],
      1,
    );

    // When
    const middle = resolveSidebarRowWindow(layout, 8, 3);
    const top = resolveSidebarRowWindow(layout, 0, 2);
    const bottom = resolveSidebarRowWindow(
      layout,
      layout.contentHeight,
      3,
    );

    // Then
    expect(layout.rows.map(({ id, top: rowTop, bottom: rowBottom }) => [id, rowTop, rowBottom])).toEqual([
      ["a", 0, 2],
      ["b", 3, 7],
      ["c", 8, 11],
      ["d", 12, 14],
      ["e", 15, 19],
      ["f", 20, 22],
      ["g", 23, 26],
    ]);
    expect(layout.contentHeight).toBe(26);
    expect(middle.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(middle.beforeHeight).toBe(0);
    expect(middle.afterHeight).toBe(6);
    expect(
      middle.beforeHeight +
        middle.rows.reduce(
          (height, row) => height + row.height + row.gapAfter,
          0,
        ) +
        middle.afterHeight,
    ).toBe(layout.contentHeight);
    expect(top.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(bottom.rows.map((row) => row.id)).toEqual(["e", "f", "g"]);
  });

  it("moves selection through the complete logical row index", () => {
    // Given
    const logicalRows = Array.from({ length: 1_498 }, (_, index) => ({
      id: `row-${index}`,
      height: index % 2 === 0 ? 2 : 3,
    }));
    const layout = buildSidebarRowLayoutIndex(logicalRows, 0);

    // When
    const nextID = moveSidebarRowSelection(layout, "row-1000", 1);

    // Then
    expect(nextID).toBe("row-1001");
  });

  it("moves keyboard selection through parent-before-child nested rows", () => {
    // Given
    const snapshot = resolveSidebarSubagentSnapshot({
      state: stateWith([
        child({
          id: "ses_parent_row",
          parentID: "ses_root",
          targetSessionID: "ses_parent_row",
        }),
        child({
          id: "ses_nested_row",
          parentID: "ses_parent_row",
          targetSessionID: "ses_nested_row",
        }),
      ]),
      sessionID: "ses_root",
    });
    const layout = buildSidebarRowLayoutIndex(
      snapshot.visibleRows.map(({ child: item }) => ({
        id: item.id,
        height: 2,
      })),
      0,
    );

    // When
    const nextID = moveSidebarRowSelection(layout, "ses_parent_row", 1);

    // Then
    expect(snapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_parent_row",
      "ses_nested_row",
    ]);
    expect(nextID).toBe("ses_nested_row");
  });

  it("falls back to logical target activation for a selected off-window row", () => {
    // Given
    const mountedActivation = vi.fn();
    const navigate = vi.fn();
    const mountedActivations = new Map([["row-0", mountedActivation]]);

    // When
    activateSidebarSelection({
      selectedRowID: "row-1000",
      mountedActivations,
      targetSessionID: "ses-target-1000",
      navigate,
    });

    // Then
    expect(mountedActivation).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("ses-target-1000");
  });

  it("keeps mounted row activation ahead of logical fallback navigation", () => {
    // Given
    const mountedActivation = vi.fn();
    const navigate = vi.fn();

    // When
    activateSidebarSelection({
      selectedRowID: "row-mounted",
      mountedActivations: new Map([["row-mounted", mountedActivation]]),
      targetSessionID: "ses-target-mounted",
      navigate,
    });

    // Then
    expect(mountedActivation).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("uses canonical nested activation for a mounted clickable row", () => {
    // Given
    const remember = vi.fn();
    const navigate = vi.fn();
    const nestedRow = {
      child: child({
        id: "ses_nested",
        parentID: "ses_parent",
        targetSessionID: "ses_nested",
      }),
      depth: 1,
      parentSessionID: "ses_parent",
    };
    const mountedActivation = () =>
      activateSubagentTreeRow({
        row: nestedRow,
        showCompletedHistory: true,
        remember,
        navigate,
      });

    // When
    activateSidebarSelection({
      selectedRowID: "ses_nested",
      mountedActivations: new Map([["ses_nested", mountedActivation]]),
      targetSessionID: "ses_nested",
      navigate,
    });

    // Then
    expect(remember).toHaveBeenCalledWith({
      parentSessionID: "ses_parent",
      childSessionID: "ses_nested",
      childRowID: "ses_nested",
      showCompletedHistory: true,
    });
    expect(navigate).toHaveBeenCalledExactlyOnceWith("ses_nested");
  });

  it("uses canonical nested activation for an off-window row", () => {
    // Given
    const remember = vi.fn();
    const navigate = vi.fn();
    const nestedRow = {
      child: child({
        id: "tool:row",
        source: "tool" as const,
        targetSessionID: "ses_nested",
      }),
      depth: 3,
      parentSessionID: "ses_immediate_parent",
    };

    // When
    activateSidebarSelection({
      selectedRowID: nestedRow.child.id,
      mountedActivations: new Map(),
      targetSessionID: nestedRow.child.targetSessionID,
      navigate: () =>
        activateSubagentTreeRow({
          row: nestedRow,
          showCompletedHistory: false,
          remember,
          navigate,
        }),
    });

    // Then
    expect(remember).toHaveBeenCalledWith({
      parentSessionID: "ses_immediate_parent",
      childSessionID: "ses_nested",
      childRowID: "tool:row",
      showCompletedHistory: false,
    });
    expect(navigate).toHaveBeenCalledExactlyOnceWith("ses_nested");
  });

  it("restores valid logical selection and falls back after history rows disappear", () => {
    // Given
    const historyLayout = buildSidebarRowLayoutIndex(
      [
        { id: "running", height: 3 },
        { id: "history-selected", height: 2 },
        { id: "history-next", height: 2 },
      ],
      0,
    );
    const activeLayout = buildSidebarRowLayoutIndex(
      [{ id: "running", height: 3 }],
      0,
    );

    // When
    const restored = resolveSidebarSelectedRowID(
      historyLayout,
      "history-selected",
    );
    const afterHistoryToggle = resolveSidebarSelectedRowID(
      activeLayout,
      "history-selected",
    );
    const afterDeletion = preservedSidebarScrollTop({
      expanded: true,
      offsetTop: 99,
      anchor: {
        childIDs: ["history-selected", "history-next"],
        intraRowOffset: 1,
      },
      rows: historyLayout.rows.filter((row) => row.id !== "history-selected"),
      scrollTop: 0,
      scrollHeight: historyLayout.contentHeight,
      viewportHeight: 3,
    });

    // Then
    expect(restored).toBe("history-selected");
    expect(afterHistoryToggle).toBe("running");
    expect(afterDeletion).toBe(3);
  });

  it("normalizes malformed row geometry and handles empty logical history", () => {
    // Given
    const malformed = buildSidebarRowLayoutIndex(
      [
        { id: "not-finite", height: Number.NaN },
        { id: "negative", height: -4 },
      ],
      Number.NaN,
    );
    const empty = buildSidebarRowLayoutIndex([], 0);

    // When
    const malformedWindow = resolveSidebarRowWindow(malformed, Number.NaN, 0);
    const emptyWindow = resolveSidebarRowWindow(empty, 0, 20);

    // Then
    expect(malformed.rows.map((row) => row.height)).toEqual([1, 1]);
    expect(malformedWindow.rows.map((row) => row.id)).toEqual([
      "not-finite",
      "negative",
    ]);
    expect(emptyWindow).toMatchObject({
      rows: [],
      beforeHeight: 0,
      afterHeight: 0,
    });
    expect(resolveSidebarSelectedRowID(empty, "stale")).toBeUndefined();
  });

  it("preserves sidebar scroll with the visible row anchor first", () => {
    expect(
      preservedSidebarAnchorScrollTop({
        expanded: true,
        anchor: {
          childIDs: ["ses_5", "ses_6", "ses_7"],
          intraRowOffset: 1,
        },
        rows: [
          { id: "ses_1", height: 3 },
          { id: "ses_2", height: 3 },
          { id: "ses_5", height: 3 },
          { id: "ses_6", height: 3 },
          { id: "ses_7", height: 3 },
        ],
        scrollTop: 0,
        scrollHeight: 15,
        viewportHeight: 5,
      }),
    ).toBe(7);

    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 99,
        anchor: {
          childIDs: ["ses_removed", "ses_6", "ses_7"],
          intraRowOffset: 1,
        },
        rows: [
          { id: "ses_1", height: 3 },
          { id: "ses_2", height: 3 },
          { id: "ses_6", height: 3 },
          { id: "ses_7", height: 3 },
        ],
        scrollTop: 0,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBe(6);
  });

  it("characterizes scroll preservation with visible anchor first and bounded numeric fallback", () => {
    expect(
      preservedSidebarAnchorScrollTop({
        expanded: true,
        anchor: {
          childIDs: ["ses_5", "ses_6", "ses_7"],
          intraRowOffset: 1,
        },
        rows: [
          { id: "ses_1", height: 3 },
          { id: "ses_2", height: 3 },
          { id: "ses_5", height: 3 },
          { id: "ses_6", height: 3 },
          { id: "ses_7", height: 3 },
        ],
        scrollTop: 0,
        scrollHeight: 15,
        viewportHeight: 5,
      }),
    ).toBe(7);
  });

  it("characterizes focus restoration with first visible anchor after row removal", () => {
    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 99,
        anchor: {
          childIDs: ["ses_removed", "ses_6", "ses_7"],
          intraRowOffset: 1,
        },
        rows: [
          { id: "ses_1", height: 3 },
          { id: "ses_2", height: 3 },
          { id: "ses_6", height: 3 },
          { id: "ses_7", height: 3 },
        ],
        scrollTop: 0,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBe(6);
  });

  it("does not fall back to stale numeric offset when anchor already matches top", () => {
    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 6,
        anchor: {
          childIDs: ["ses_1", "ses_2"],
          intraRowOffset: 0,
        },
        rows: [
          { id: "ses_1", height: 3 },
          { id: "ses_2", height: 3 },
        ],
        scrollTop: 0,
        scrollHeight: 8,
        viewportHeight: 5,
      }),
    ).toBeUndefined();
  });

  it("falls back to bounded numeric sidebar scroll preservation", () => {
    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 99,
        scrollTop: 0,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBe(7);
    expect(
      preservedSidebarScrollTop({
        expanded: false,
        offsetTop: 6,
        scrollTop: 0,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBeUndefined();
    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 6,
        scrollTop: 6,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBeUndefined();
  });

  it("does not show other-session rows by default when current session has no executions", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "ses_other_running",
        title: "Other session running",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_running",
        messageID: "msg_other_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
    ]);

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
    });

    expect(snapshot.showingOtherSessions).toBe(false);
    expect(snapshot.visibleRows).toEqual([]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(0);
  });

  it("keeps retained terminal counters separate from default visible rows", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const retainedDone = Array.from({ length: 6 }, (_, index) =>
      child({
        id: `ses_done_${index}`,
        title: `Retained done ${index}`,
        source: "session",
        targetSessionID: `ses_done_${index}`,
        messageID: `msg_done_${index}`,
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    );
    const retainedErrors = Array.from({ length: 7 }, (_, index) =>
      child({
        id: `ses_error_${index}`,
        title: `Retained error ${index}`,
        source: "session",
        targetSessionID: `ses_error_${index}`,
        messageID: `msg_error_${index}`,
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    );
    const state = stateWith([
      child({
        id: "ses_running",
        title: "Active child",
        source: "session",
        targetSessionID: "ses_running",
        messageID: "msg_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
      ...retainedDone,
      ...retainedErrors,
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
    });
    const historySnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });

    expect(defaultSnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_running",
    ]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 1,
      done: 6,
      error: 7,
    });
    expect(defaultSnapshot.totalExecuted).toBe(14);
    expect(historySnapshot.visibleRows).toHaveLength(14);
    expect(historySnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual(
      expect.arrayContaining(["ses_done_0", "ses_error_0"]),
    );
    expect(historySnapshot.visibleCounts).toEqual(defaultSnapshot.visibleCounts);
    expect(historySnapshot.totalExecuted).toBe(defaultSnapshot.totalExecuted);
  });

  it("keeps rows and counters in the current session scope when current history is hidden", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "ses_current_done_old",
        title: "Current retained done",
        source: "session",
        parentID: "ses_current",
        targetSessionID: "ses_current_done_old",
        messageID: "msg_current_done",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
      child({
        id: "ses_current_error_old",
        title: "Current retained error",
        source: "session",
        parentID: "ses_current",
        targetSessionID: "ses_current_error_old",
        messageID: "msg_current_error",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:03:00.000Z",
        updatedAt: "2026-04-30T10:03:00.000Z",
      }),
      child({
        id: "ses_other_running",
        title: "Other session running",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_running",
        messageID: "msg_other_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
    });
    const historySnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
      showCompletedHistory: true,
    });

    expect(defaultSnapshot.showingOtherSessions).toBe(false);
    expect(defaultSnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 0,
      done: 1,
      error: 1,
    });
    expect(defaultSnapshot.totalExecuted).toBe(2);
    expect(historySnapshot.visibleRows).toHaveLength(2);
    expect(historySnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual(
      expect.arrayContaining([
        "ses_current_error_old",
        "ses_current_done_old",
      ]),
    );
    expect(historySnapshot.visibleCounts).toEqual(defaultSnapshot.visibleCounts);
    expect(historySnapshot.totalExecuted).toBe(defaultSnapshot.totalExecuted);
  });

  it("does not fall back to other-session rows when current session has no retained executions", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "tool_current_wrapper",
        title: "Current wrapper only",
        source: "tool",
        parentID: "ses_current",
        targetSessionID: undefined,
        messageID: "msg_current_wrapper",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:19:00.000Z",
        updatedAt: "2026-04-30T10:19:00.000Z",
      }),
      child({
        id: "ses_other_running",
        title: "Other session running",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_running",
        messageID: "msg_other_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
      child({
        id: "ses_other_done_old",
        title: "Other retained done",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_done_old",
        messageID: "msg_other_done",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
    });

    expect(defaultSnapshot.showingOtherSessions).toBe(false);
    expect(defaultSnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 0,
      done: 0,
      error: 0,
    });
    expect(defaultSnapshot.totalExecuted).toBe(0);
  });

  it("keeps the sidebar snapshot scoped to the current session", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "tool_current_wrapper",
        title: "Current wrapper only",
        source: "tool",
        parentID: "ses_current",
        targetSessionID: undefined,
        messageID: "msg_current_wrapper",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:19:00.000Z",
        updatedAt: "2026-04-30T10:19:00.000Z",
      }),
      child({
        id: "ses_other_running",
        title: "Other session running",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_running",
        messageID: "msg_other_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
    ]);

    const snapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
    });

    expect(snapshot.showingOtherSessions).toBe(false);
    expect(snapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(0);
  });

  it("computes sidebar total from counted current-session execution identities", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith(
      [
        child({
          id: "tool_current_proxy",
          title: "task",
          source: "tool",
          parentID: "ses_current",
          targetSessionID: "ses_current_child",
          messageID: "msg_current",
          status: "done",
          color: "green",
          endedAt: "2026-04-30T10:19:00.000Z",
          updatedAt: "2026-04-30T10:19:00.000Z",
        }),
        child({
          id: "ses_current_child",
          title: "Current child",
          source: "session",
          parentID: "ses_current",
          targetSessionID: "ses_current_child",
          messageID: "msg_current",
          status: "done",
          color: "green",
          endedAt: "2026-04-30T10:19:00.000Z",
          updatedAt: "2026-04-30T10:19:00.000Z",
        }),
        child({
          id: "ses_current_uncounted",
          title: "Uncounted current child",
          source: "session",
          parentID: "ses_current",
          targetSessionID: "ses_current_uncounted",
          messageID: "msg_uncounted",
          status: "done",
          color: "green",
          endedAt: "2026-04-30T10:19:00.000Z",
          updatedAt: "2026-04-30T10:19:00.000Z",
        }),
        child({
          id: "ses_other_child",
          title: "Other child",
          source: "session",
          parentID: "ses_other",
          targetSessionID: "ses_other_child",
          status: "done",
          color: "green",
          endedAt: "2026-04-30T10:19:00.000Z",
          updatedAt: "2026-04-30T10:19:00.000Z",
        }),
      ],
      ["ses_current_child", "ses_other_child"],
    );

    const snapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
      showCompletedHistory: true,
    });

    expect(snapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_current_child",
      "ses_current_uncounted",
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 2, error: 0 });
    expect(snapshot.totalExecuted).toBe(1);
  });

  it("resolves sidebar and home snapshots from classified real executions only", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "tool:delegate-wrapper",
        title: "Delegation: inspect counters",
        source: "tool",
        toolName: "delegate",
        targetSessionID: undefined,
        messageID: "msg_delegate",
      }),
      child({
        id: "tool:task-proxy",
        title: "task",
        source: "tool",
        toolName: "task",
        targetSessionID: "ses_real_running",
        messageID: "msg_real_running",
      }),
      child({
        id: "ses_real_running",
        title: "Delegation: real child still counts",
        source: "session",
        targetSessionID: "ses_real_running",
        messageID: "msg_real_running",
        status: "running",
      }),
      child({
        id: "ses_real_done_old",
        title: "Completed child",
        source: "session",
        targetSessionID: "ses_real_done_old",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    ]);

    const sidebar = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
    });
    const home = resolveTuiSubagentSnapshot({ state, nowMs });

    expect(sidebar.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_real_running",
    ]);
    expect(sidebar.visibleCounts).toEqual({ running: 1, done: 1, error: 0 });
    expect(sidebar.totalExecuted).toBe(2);
    expect(home.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_real_running",
    ]);
    expect(home.visibleCounts).toEqual(sidebar.visibleCounts);
    expect(home.totalExecuted).toBe(2);
  });

  it("shows completed real history without adding wrappers to visible counts", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "tool:old-wrapper",
        title: "delegate",
        source: "tool",
        toolName: "delegate",
        targetSessionID: undefined,
      }),
      child({
        id: "ses_real_done_old",
        title: "Delegation: old but real",
        source: "session",
        targetSessionID: "ses_real_done_old",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    ]);

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });

    expect(snapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_real_done_old",
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 1, error: 0 });
    expect(snapshot.totalExecuted).toBe(1);
  });

  it("keeps stale errors historical while retaining status counters", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "ses_real_running",
        title: "Active child",
        source: "session",
        targetSessionID: "ses_real_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
      child({
        id: "ses_real_error_old",
        title: "Old failed child",
        source: "session",
        targetSessionID: "ses_real_error_old",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
    });
    const historySnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });

    expect(defaultSnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_real_running",
    ]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 1,
      done: 0,
      error: 1,
    });
    expect(defaultSnapshot.totalExecuted).toBe(2);
    expect(historySnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_real_running",
      "ses_real_error_old",
    ]);
    expect(historySnapshot.visibleCounts).toEqual({
      running: 1,
      done: 0,
      error: 1,
    });
    expect(historySnapshot.totalExecuted).toBe(2);
  });

  it("excludes recent unrelated errors from active rows while retaining counters", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "ses_real_running",
        title: "Active child",
        source: "session",
        targetSessionID: "ses_real_running",
        messageID: "msg_active",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
      child({
        id: "ses_real_error_active",
        title: "Active failed child",
        source: "session",
        targetSessionID: "ses_real_error_active",
        messageID: "msg_active",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:19:00.000Z",
        updatedAt: "2026-04-30T10:19:00.000Z",
      }),
      child({
        id: "ses_real_error_recent_unrelated",
        title: "Recent unrelated failed child",
        source: "session",
        targetSessionID: "ses_real_error_recent_unrelated",
        messageID: "msg_unrelated",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:19:30.000Z",
        updatedAt: "2026-04-30T10:19:30.000Z",
      }),
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
    });
    const historySnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });

    expect(defaultSnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_real_running",
      "ses_real_error_active",
    ]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 1,
      done: 0,
      error: 2,
    });
    expect(defaultSnapshot.totalExecuted).toBe(3);
    expect(historySnapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_real_running",
      "ses_real_error_active",
      "ses_real_error_recent_unrelated",
    ]);
    expect(historySnapshot.visibleCounts).toEqual({
      running: 1,
      done: 0,
      error: 2,
    });
    expect(historySnapshot.totalExecuted).toBe(3);
  });

  it("backfills hydrated targets only when the real session match is unique", () => {
    const ambiguous = stateWith([
      child({
        id: "tool:ambiguous",
        source: "tool",
        toolName: "task",
        targetSessionID: undefined,
        messageID: "msg_wrapper",
      }),
      child({ id: "ses_first", targetSessionID: "ses_first" }),
      child({ id: "ses_second", targetSessionID: "ses_second" }),
    ]);

    expect(backfillHydratedTargetSessionIDs(ambiguous, "ses_parent")).toBe(
      false,
    );
    expect(ambiguous.children["tool:ambiguous"]?.targetSessionID).toBeUndefined();

    const unique = stateWith([
      child({
        id: "tool:matched",
        source: "tool",
        toolName: "task",
        targetSessionID: undefined,
        messageID: "msg_real",
      }),
      child({
        id: "ses_first",
        targetSessionID: "ses_first",
        messageID: "msg_other",
      }),
      child({
        id: "ses_second",
        targetSessionID: "ses_second",
        messageID: "msg_real",
      }),
    ]);

    expect(backfillHydratedTargetSessionIDs(unique, "ses_parent")).toBe(true);
    expect(unique.children["tool:matched"]?.targetSessionID).toBe("ses_second");
  });
});

describe("hydratePreviousSubagents", () => {
  const hydratedChild = {
    id: "ses_child",
    parentID: "ses_parent",
    title: "Hydrated child",
    agent: "sdd-propose",
    time: { created: "2026-04-30T10:00:00.000Z" },
  };

  it("writes TUI debug events to tui-events.log when enabled", async () => {
    // Given
    const harness = await createFileHarness();
    process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS = "1";
    process.env.XDG_RUNTIME_DIR = harness.dir;
    const fixture = createHydrationApi({
      directory: harness.dir,
      graph: { ses_parent: [] },
    });

    // When
    const hydrated = await hydratePreviousSubagents({
      api: fixture.api,
      currentSessionID: "ses_parent",
      statePath: harness.statePath,
      textPath: harness.textPath,
      setState: () => {
        throw new Error("state update failed");
      },
    });

    // Then
    expect(hydrated).toBe(false);
    const entry = JSON.parse(
      await readFile(
        join(harness.dir, "opencode-subagent-statusline", "tui-events.log"),
        "utf8",
      ),
    );
    expect(entry).toMatchObject({
      kind: "hydration.error",
      sessionID: "ses_parent",
    });
    expect(
      (
        await stat(join(harness.dir, "opencode-subagent-statusline"))
      ).mode & 0o777,
    ).toBe(0o700);
    expect(
      (
        await stat(
          join(
            harness.dir,
            "opencode-subagent-statusline",
            "tui-events.log",
          ),
        )
      ).mode & 0o777,
    ).toBe(0o600);
  });

  it("repairs permissive TUI debug event path modes", async () => {
    // Given
    const harness = await createFileHarness();
    process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS = "1";
    process.env.XDG_RUNTIME_DIR = harness.dir;
    const diagnosticDir = join(harness.dir, "opencode-subagent-statusline");
    const logPath = join(diagnosticDir, "tui-events.log");
    await mkdir(diagnosticDir, { mode: 0o777 });
    await writeFile(logPath, "", { mode: 0o666 });
    await chmod(diagnosticDir, 0o777);
    await chmod(logPath, 0o666);
    const fixture = createHydrationApi({
      directory: harness.dir,
      graph: { ses_parent: [] },
    });

    // When
    const hydrated = await hydratePreviousSubagents({
      api: fixture.api,
      currentSessionID: "ses_parent",
      statePath: harness.statePath,
      textPath: harness.textPath,
      setState: () => {
        throw new Error("state update failed");
      },
    });

    // Then
    expect(hydrated).toBe(false);
    expect((await stat(diagnosticDir)).mode & 0o777).toBe(0o700);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("closes the TUI debug descriptor when appending diagnostics fails", async () => {
    // Given
    const harness = await createFileHarness();
    process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS = "1";
    process.env.XDG_RUNTIME_DIR = harness.dir;
    fsMockState.appendShouldThrow = true;
    fsMockState.appendCalls = 0;
    fsMockState.appendDescriptors.length = 0;
    fsMockState.closeDescriptors.length = 0;
    fsMockState.lifecycle.length = 0;

    try {
      // When
      await expect(
        hydratePreviousSubagents({
          api: createHydrationApi({
            directory: harness.dir,
            graph: { ses_parent: [] },
          }).api,
          currentSessionID: "ses_parent",
          statePath: harness.statePath,
          textPath: harness.textPath,
          setState: () => {
            throw new Error("state update failed");
          },
        }),
      ).resolves.toBe(false);

      // Then
      expect(fsMockState.appendCalls).toBe(1);
      // debugLog now uses appendFileSync with a string path and no longer
      // maintains a per-call openSync/closeSync descriptor pair.
      expect(fsMockState.appendDescriptors).toHaveLength(0);
      expect(fsMockState.closeDescriptors).toHaveLength(0);
    } finally {
      fsMockState.appendShouldThrow = false;
      fsMockState.appendCalls = 0;
      fsMockState.appendDescriptors.length = 0;
      fsMockState.closeDescriptors.length = 0;
      fsMockState.lifecycle.length = 0;
    }
  });

  it("hydrates a descendant batch with shared reads and one state/persistence commit", async () => {
    // Given
    const graph: Record<string, readonly unknown[]> = {
      ses_root: [
        {
          id: "ses_child",
          parentID: "ses_root",
          directory: "/repo",
        },
      ],
      ses_child: [
        {
          id: "ses_grand",
          parentID: "ses_child",
          directory: "/repo",
        },
      ],
      ses_grand: [],
    };
    const fixture = createHydrationApi({
      directory: "/repo",
      graph,
      statuses: {
        ses_child: { status: "running" },
        ses_grand: { status: "running" },
      },
    });
    let current = stateWith([]);
    const setState = vi.fn(
      (update: (previous: StatuslineState) => StatuslineState) => {
        current = update(current);
      },
    );
    const writes: StatuslineState[] = [];
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ state }) => {
        writes.push(state);
      },
    );

    // When
    await hydratePreviousSubagents({
      api: fixture.api,
      currentSessionID: "ses_root",
      statePath: "/repo/state.json",
      textPath: "/repo/status.txt",
      setState,
      persistenceCoordinator: persistence,
    });

    // Then
    const messageSessionIDs = fixture.messages.mock.calls.map(
      (call) => call[0].sessionID,
    );
    const requestedParents = fixture.children.mock.calls.map(
      (call) => call[0].sessionID,
    );
    expect(fixture.children).toHaveBeenCalledTimes(3);
    expect(fixture.status).toHaveBeenCalledOnce();
    expect(new Set(requestedParents).size).toBe(requestedParents.length);
    expect(new Set(messageSessionIDs).size).toBe(messageSessionIDs.length);
    expect(
      fixture.messages.mock.calls.every(
        ([request]) => request.limit === ROUTE_CHILD_MESSAGE_LIMIT,
      ),
    ).toBe(true);
    expect(setState).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    persistence.close();
  });

  it("hydrates and projects a complete deep tree with evidence and stable sibling order", async () => {
    // Given
    let state = stateWith([]);
    const fixture = createHydrationApi({
      directory: "/repo",
      graph: {
        ses_root: [
          {
            id: "ses_new",
            parentID: "ses_root",
            directory: "/repo",
            time: { created: 20 },
          },
          {
            id: "ses_old",
            parentID: "ses_root",
            directory: "/repo",
            time: { created: 10 },
          },
        ],
        ses_new: [
          {
            id: "ses_grand",
            parentID: "ses_new",
            directory: "/repo",
          },
        ],
        ses_grand: [
          {
            id: "ses_deep",
            parentID: "ses_grand",
            directory: "/repo",
          },
        ],
        ses_deep: [],
        ses_old: [],
      },
      statuses: {
        ses_new: { status: "running" },
        ses_old: { status: "idle" },
        ses_grand: { status: "idle" },
        ses_deep: { status: "error" },
      },
      messages: {
        ses_root: [],
        ses_new: [
          {
            role: "assistant",
            sessionID: "ses_new",
            providerID: "openai",
            modelID: "gpt",
            variant: "high",
            tokens: { total: 21 },
          },
        ],
        ses_old: [],
        ses_grand: [],
        ses_deep: [],
      },
    });
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async () => undefined,
    );

    // When
    await hydratePreviousSubagents({
      api: fixture.api,
      currentSessionID: "ses_root",
      statePath: "/repo/state.json",
      textPath: "/repo/status.txt",
      setState: (update) => {
        state = update(state);
      },
      persistenceCoordinator: persistence,
    });
    const snapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_root",
      showCompletedHistory: true,
    });

    // Then
    expect(
      snapshot.visibleRows.map(({ child: row, depth }) => [row.id, depth]),
    ).toEqual([
      ["ses_new", 0],
      ["ses_grand", 1],
      ["ses_deep", 2],
      ["ses_old", 0],
    ]);
    expect(snapshot.visibleRows[0]?.child.model?.variant).toBe("high");
    expect(snapshot.visibleRows[0]?.child.tokens?.total).toBe(21);
    expect(snapshot.visibleCounts).toEqual({ running: 1, done: 2, error: 1 });
    expect(snapshot.totalExecuted).toBe(4);
    persistence.close();
  });

  it("retains only bounded descendant message evidence", async () => {
    // Given
    const directory = "/repo";
    const boundaryMessages = [
      ...Array.from({ length: ROUTE_CHILD_MESSAGE_LIMIT - 1 }, (_, index) => ({
        sessionID: "ses_child",
        role: "user",
        time: { created: index + 1 },
      })),
      {
        sessionID: "ses_child",
        role: "assistant",
        providerID: "openai",
        modelID: "boundary-model",
        totalTokens: 50,
        time: { created: ROUTE_CHILD_MESSAGE_LIMIT },
      },
      {
        info: {
          sessionID: "ses_child",
          role: "assistant",
          providerID: "openai",
          modelID: "overflow-model",
          error: { name: "OverflowError" },
          totalTokens: 999,
          time: { created: ROUTE_CHILD_MESSAGE_LIMIT + 1 },
        },
        parts: [],
      },
    ];
    const fixture = createHydrationApi({
      directory,
      graph: {
        ses_parent: [{ id: "ses_child", parentID: "ses_parent", directory }],
        ses_child: [],
      },
      statuses: { ses_child: { status: "running" } },
      messages: { ses_child: boundaryMessages },
    });
    let current = stateWith([]);

    // When
    await hydratePreviousSubagents({
      api: fixture.api,
      currentSessionID: "ses_parent",
      statePath: "/repo/state.json",
      textPath: "/repo/status.txt",
      setState: (update) => {
        current = update(current);
      },
    });

    // Then
    expect(current.children.ses_child).toMatchObject({
      status: "running",
      model: { providerID: "openai", modelID: "boundary-model" },
      tokens: { total: 50 },
    });
  });

  it("drops a stale recursive hydration batch after route cancellation", async () => {
    // Given
    const controller = new AbortController();
    const fixture = createHydrationApi({
      directory: "/repo",
      graph: { ses_root: [] },
    });
    const setState = vi.fn();
    controller.abort();

    // When
    const hydrated = await hydratePreviousSubagents({
      api: fixture.api,
      currentSessionID: "ses_root",
      statePath: "/repo/state.json",
      textPath: "/repo/status.txt",
      setState,
      options: { signal: controller.signal },
    });

    // Then
    expect(hydrated).toBe(false);
    expect(setState).not.toHaveBeenCalled();
  });

  it("preserves a running child until a retry gets authoritative empty evidence", async () => {
    // Given
    const harness = await createFileHarness();
    let current = stateWith([
      child({
        id: "ses_child",
        parentID: "ses_parent",
        source: "session",
        targetSessionID: "ses_child",
        status: "running",
      }),
    ]);
    const children = vi.fn(
      async ({ sessionID }: { readonly sessionID: string }) => ({
        data:
          sessionID === "ses_parent"
            ? [
                {
                  id: "ses_child",
                  parentID: "ses_parent",
                  directory: harness.dir,
                },
              ]
            : [],
      }),
    );
    const setState = (update: (state: StatuslineState) => StatuslineState) => {
      current = update(current);
    };

    // When
    const incomplete = await hydratePreviousSubagents({
      api: {
        state: { path: { directory: harness.dir } },
        client: { session: { children } },
      },
      currentSessionID: "ses_parent",
      statePath: harness.statePath,
      textPath: harness.textPath,
      setState,
    });

    // Then
    expect(incomplete).toBe(false);
    expect(current.children.ses_child?.status).toBe("running");

    // When
    const complete = await hydratePreviousSubagents({
      api: {
        state: { path: { directory: harness.dir } },
        client: {
          session: {
            children,
            status: vi.fn(async () => ({ data: {} })),
            messages: vi.fn(async () => ({ data: [] })),
          },
        },
      },
      currentSessionID: "ses_parent",
      statePath: harness.statePath,
      textPath: harness.textPath,
      setState,
    });

    // Then
    expect(complete).toBe(true);
    expect(current.children.ses_child).toBeUndefined();
  });

  it("hydrates tokens when api.state.session.status is missing", async () => {
    // Given
    const harness = await createFileHarness();
    const expectedTokens = {
      input: 101,
      output: 102,
      total: 203,
      contextPercent: 41,
    };
    let fallbackCalls = 0;
    const stateMessages = vi.fn((sessionID: string) =>
      sessionID === "ses_status_missing"
        ? [{ id: "msg_status_missing" }]
        : [],
    );
    const statePart = vi.fn((messageID: string) =>
      messageID === "msg_status_missing"
        ? [{ tokens: expectedTokens }]
        : [],
    );
    const tui = initializeTuiForTokenHydration({
      directory: harness.dir,
      session: { messages: stateMessages },
      part: statePart,
      clientMessages: async () => {
        fallbackCalls += 1;
        return { data: [] };
      },
    });

    try {
      // When
      await tui.handler("session.created")({
        type: "session.created",
        properties: {
          sessionID: "ses_status_missing",
          info: {
            id: "ses_status_missing",
            parentID: "ses_parent",
            directory: harness.dir,
            title: "Status accessor fixture",
          },
        },
      });

      // Then
      await vi.waitFor(async () => {
        const persisted: unknown = JSON.parse(
          await readFile(harness.statePath, "utf8"),
        );
        expect(persisted).toMatchObject({
          children: {
            "ses_status_missing": { tokens: expectedTokens },
          },
        });
      });
      expect(stateMessages).toHaveBeenCalledWith("ses_status_missing");
      expect(statePart).toHaveBeenCalledWith("msg_status_missing");
      expect(fallbackCalls).toBe(0);
    } finally {
      tui.dispose();
    }
  });

  it("hydrates tokens when api.state.session.messages is missing", async () => {
    // Given
    const harness = await createFileHarness();
    const expectedTokens = {
      input: 301,
      output: 302,
      total: 603,
      contextPercent: 73,
    };
    const stateStatus = vi.fn((sessionID: string) =>
      sessionID === "tool:part_messages_missing"
        ? { tokens: { total: 603 } }
        : undefined,
    );
    const statePart = vi.fn((messageID: string) =>
      messageID === "msg_messages_missing"
        ? [{ tokens: { input: 301, output: 302, contextPercent: 73 } }]
        : [],
    );
    let fallbackCalls = 0;
    const tui = initializeTuiForTokenHydration({
      directory: harness.dir,
      session: { status: stateStatus },
      part: statePart,
      clientMessages: async () => {
        fallbackCalls += 1;
        return { data: [] };
      },
    });

    try {
      // When
      await tui.handler("message.part.updated")({
        type: "message.part.updated",
        properties: {
          sessionID: "ses_parent",
          part: {
            id: "part_messages_missing",
            type: "tool",
            tool: "task",
            sessionID: "ses_parent",
            messageID: "msg_messages_missing",
            state: {
              status: "running",
              input: { description: "Messages accessor fixture" },
            },
          },
        },
      });

      // Then
      await vi.waitFor(async () => {
        const persisted: unknown = JSON.parse(
          await readFile(harness.statePath, "utf8"),
        );
        expect(persisted).toMatchObject({
          children: {
            "tool:part_messages_missing": { tokens: expectedTokens },
          },
        });
      });
      expect(stateStatus).toHaveBeenCalledWith("tool:part_messages_missing");
      expect(statePart).toHaveBeenCalledWith("msg_messages_missing");
      expect(fallbackCalls).toBe(0);
    } finally {
      tui.dispose();
    }
  });

  it("reports incomplete hydration when child discovery is unavailable", async () => {
    // Given
    const harness = await createFileHarness();

    // When
    const hydrated = await hydratePreviousSubagents({
      api: {
        state: { path: { directory: harness.dir } },
        client: {
          session: {
            status: vi.fn(async () => ({ data: {} })),
            messages: vi.fn(async () => ({ data: [] })),
          },
        },
      },
      currentSessionID: "ses_parent",
      statePath: harness.statePath,
      textPath: harness.textPath,
      setState: () => undefined,
    });

    // Then
    expect(hydrated).toBe(false);
  });

  it("skips child-session stubs with no status, messages, or parent evidence", async () => {
    const state = await hydrateState({
      children: [hydratedChild],
      childMessages: { ses_child: [] },
      statuses: {},
    });

    expect(state.children).not.toHaveProperty("ses_child");
    expect(
      resolveTuiSubagentSnapshot({ state, sessionID: "ses_parent" })
        .visibleCounts,
    ).toEqual({ running: 0, done: 0, error: 0 });
  });

  it("hydrates a child with explicit running status", async () => {
    const state = await hydrateState({
      children: [hydratedChild],
      childMessages: { ses_child: [] },
      statuses: { ses_child: { status: "running" } },
    });

    expect(state.children["ses_child"]?.status).toBe("running");
    expect(
      resolveTuiSubagentSnapshot({ state, sessionID: "ses_parent" })
        .visibleCounts,
    ).toEqual({ running: 1, done: 0, error: 0 });
  });

  it("hydrates model metadata from direct and enveloped child messages", async () => {
    const state = await hydrateState({
      children: [
        hydratedChild,
        { ...hydratedChild, id: "ses_envelope" },
      ],
      childMessages: {
        ses_child: [{
          sessionID: "ses_child",
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5.6",
          variant: "high",
          time: { created: 10 },
        }],
        ses_envelope: [{
          info: {
            sessionID: "ses_envelope",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet",
            variant: "max",
            time: { created: 20 },
          },
          parts: [],
        }],
      },
      statuses: {
        ses_child: { status: "running" },
        ses_envelope: { status: "running" },
      },
    });

    expect(state.children.ses_child.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6",
      variant: "high",
    });
    expect(state.children.ses_envelope.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
      variant: "max",
    });
  });

  it("hydrates terminal done and error evidence", async () => {
    const errorAt = new Date().toISOString();
    const state = await hydrateState({
      children: [
        { ...hydratedChild, id: "ses_done", title: "Done child" },
        { ...hydratedChild, id: "ses_error", title: "Error child" },
      ],
      childMessages: {
        ses_done: [],
        ses_error: [
          {
            info: {
              role: "assistant",
              error: { detail: "Unsupported content type" },
              time: { updated: errorAt },
            },
            parts: [],
          },
        ],
      },
      statuses: { ses_done: { status: "idle" } },
    });

    expect(state.children["ses_done"]?.status).toBe("done");
    expect(state.children["ses_error"]?.status).toBe("error");
    expect(
      resolveTuiSubagentSnapshot({ state, sessionID: "ses_parent" })
        .visibleCounts,
    ).toEqual({ running: 0, done: 1, error: 1 });
  });

  it("hydrates a child linked by parent tool evidence", async () => {
    const state = await hydrateState({
      children: [hydratedChild],
      parentMessages: [
        {
          id: "msg_parent",
          info: { id: "msg_parent", role: "assistant" },
          parts: [
            {
              id: "part_task",
              type: "tool",
              tool: "task",
              sessionID: "ses_parent",
              state: {
                status: "running",
                metadata: { sessionId: "ses_child" },
                input: {
                  description: "Hydrated child",
                  subagent_type: "sdd-propose",
                },
              },
            },
          ],
        },
      ],
      childMessages: { ses_child: [] },
      statuses: {},
    });

    expect(state.children["ses_child"]?.status).toBe("running");
    expect(state.children["tool:part_task"]?.targetSessionID).toBe(
      "ses_child",
    );
  });

  it("hydrates terminal parent task evidence onto the real child session", async () => {
    const completedAt = new Date().toISOString();
    const state = await hydrateState({
      children: [hydratedChild],
      parentMessages: [
        {
          id: "msg_parent",
          info: {
            id: "msg_parent",
            role: "assistant",
            time: { completed: completedAt },
          },
          parts: [
            {
              id: "part_task",
              type: "tool",
              tool: "task",
              sessionID: "ses_parent",
              state: {
                status: "completed",
                metadata: { sessionId: "ses_child" },
                input: {
                  description: "Hydrated child",
                  subagent_type: "sdd-propose",
                },
              },
            },
          ],
        },
      ],
      childMessages: { ses_child: [] },
      statuses: {},
    });

    expect(state.children["ses_child"]?.status).toBe("done");
    expect(state.children["tool:part_task"]?.status).toBe("done");
  });

  it("does not hydrate an empty child from an incidental parent text mention", async () => {
    const state = await hydrateState({
      children: [hydratedChild],
      parentMessages: [
        {
          id: "msg_parent",
          info: { id: "msg_parent", role: "assistant" },
          parts: [
            {
              id: "part_text",
              type: "text",
              text: "The log mentioned ses_child, but no task metadata linked it.",
            },
            {
              id: "part_task",
              type: "tool",
              tool: "task",
              sessionID: "ses_parent",
              state: {
                status: "completed",
                output: "unstructured log mentioned ses_child",
                input: { description: "Unrelated task" },
              },
            },
          ],
        },
      ],
      childMessages: { ses_child: [] },
      statuses: {},
    });

    expect(state.children).not.toHaveProperty("ses_child");
  });
});

describe("probeRunningEvidence", () => {
  it("lets client status nested error evidence override direct done status", async () => {
    const api = {
      state: {
        session: {
          status: vi.fn(() => "done"),
        },
      },
      client: {
        session: {
          status: vi.fn(async () => ({
            data: {
              ses_child: {
                status: "idle",
                info: { error: { detail: "Unsupported content type" } },
              },
            },
          })),
          messages: vi.fn(async () => ({ data: [] })),
        },
      },
    } as unknown as TuiPluginApi;

    const evidence = await probeRunningEvidence({
      api,
      targetSessionID: "ses_child",
      directory: "/repo",
      candidateAgeMs: 60_000,
      nowMs: Date.now(),
    });

    expect(evidence.status).toBe("error");
    expect(api.client.session.status).toHaveBeenCalledOnce();
    expect(api.client.session.messages).not.toHaveBeenCalled();
  });
});

describe("TUI subagent hydration", () => {
  async function hydrateWith(input: {
    initialChildren?: ChildSessionState[];
    children: unknown[];
    statuses?: Record<string, unknown>;
    messagesBySession?: Record<string, unknown[]>;
    failMessagesFor?: string[];
    messageErrorsFor?: string[];
    failStatus?: boolean;
  }): Promise<StatuslineState> {
    let state = stateWith(input.initialChildren ?? []);
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-hydrate-"));
    const hydratedChildren = input.children.map((row) =>
      typeof row === "object" && row !== null
        ? { directory, ...row }
        : row,
    );
    const api: RouteHydrationApi = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(
            async ({ sessionID }: { readonly sessionID: string }) => ({
              data: sessionID === "ses_parent" ? hydratedChildren : [],
            }),
          ),
          messages: vi.fn(async ({ sessionID }: { sessionID: string }) => {
            if (input.failMessagesFor?.includes(sessionID)) {
              throw new Error(`failed to read messages for ${sessionID}`);
            }
            if (input.messageErrorsFor?.includes(sessionID)) {
              return {
                data: undefined,
                error: { name: "MessageReadError" },
              };
            }
            return { data: input.messagesBySession?.[sessionID] ?? [] };
          }),
          status: vi.fn(async () => {
            if (input.failStatus) {
              throw new Error("failed to read statuses");
            }
            return { data: input.statuses ?? {} };
          }),
        },
      },
    };

    await hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: (fn) => {
        state = fn(state);
      },
    });

    return state;
  }

  it("does not leave visible running rows from historical children without status evidence", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_historical",
          parentID: "ses_parent",
          title: "Historical child",
          source: "session",
          targetSessionID: "ses_child_historical",
          status: "running",
        }),
      ],
      children: [
        {
          id: "ses_child_historical",
          parentID: "ses_parent",
          title: "Historical child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      statuses: {},
    });

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(Object.keys(state.children)).toEqual([]);
    expect(snapshot.visibleRows).toEqual([]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(0);
  });

  it("preserves an existing running row when child-message evidence fails", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          source: "session",
          targetSessionID: "ses_child_running",
          status: "running",
        }),
      ],
      children: [
        {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      statuses: {},
      failMessagesFor: ["ses_child_running"],
    });

    expect(state.children.ses_child_running?.status).toBe("running");
  });

  it("preserves an existing running row when the API returns an error envelope", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_running",
          parentID: "ses_parent",
          targetSessionID: "ses_child_running",
          status: "running",
        }),
      ],
      children: [{ id: "ses_child_running", parentID: "ses_parent" }],
      statuses: {},
      messageErrorsFor: ["ses_child_running"],
    });

    expect(state.children.ses_child_running?.status).toBe("running");
  });

  it("hydrates every child message with bounded concurrency", async () => {
    const children = Array.from({ length: 70 }, (_, index) => ({
      id: `ses_child_${index}`,
      parentID: "ses_parent",
      title: `Child ${index}`,
      time: { created: index },
    }));
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let childRequests = 0;
    const gate = deferred<void>();
    const saturated = deferred<void>();
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-budget-"));
    const api = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(
            async ({ sessionID }: { readonly sessionID: string }) => ({
              data:
                sessionID === "ses_parent"
                  ? children.map((row) => ({ ...row, directory }))
                  : [],
            }),
          ),
          status: vi.fn(async () => ({ data: {} })),
          messages: vi.fn(async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "ses_parent") return { data: [] };
            childRequests += 1;
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            if (activeRequests === ROUTE_CHILD_MESSAGE_CONCURRENCY) {
              saturated.resolve(undefined);
            }
            await gate.promise;
            activeRequests -= 1;
            return { data: [] };
          }),
        },
      },
    } satisfies RouteHydrationApi;

    const hydration = hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: () => undefined,
    });
    await saturated.promise;
    expect(activeRequests).toBe(ROUTE_CHILD_MESSAGE_CONCURRENCY);
    expect(childRequests).toBe(ROUTE_CHILD_MESSAGE_CONCURRENCY);
    gate.resolve(undefined);
    await hydration;

    expect(maxActiveRequests).toBe(ROUTE_CHILD_MESSAGE_CONCURRENCY);
    expect(childRequests).toBe(70);
  });

  it("prioritizes running and recent route children within the admission budget", async () => {
    const children = [
      { id: "ses_old", parentID: "ses_parent", time: { updated: 1 } },
      { id: "ses_older", parentID: "ses_parent", time: { updated: 2 } },
      { id: "ses_recent", parentID: "ses_parent", time: { updated: 100 } },
      { id: "ses_middle", parentID: "ses_parent", time: { updated: 50 } },
      { id: "ses_running", parentID: "ses_parent", time: { updated: 0 } },
    ];
    const requested: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-priority-"));
    const api = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(
            async ({ sessionID }: { readonly sessionID: string }) => ({
              data:
                sessionID === "ses_parent"
                  ? children.map((row) => ({ ...row, directory }))
                  : [],
            }),
          ),
          status: vi.fn(async () => ({
            data: { ses_running: { status: "running" } },
          })),
          messages: vi.fn(async ({ sessionID }: { sessionID: string }) => {
            if (sessionID !== "ses_parent") requested.push(sessionID);
            return { data: [] };
          }),
        },
      },
    } satisfies RouteHydrationApi;

    await hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: () => undefined,
    });

    expect(requested[0]).toBe("ses_running");
    expect(requested.indexOf("ses_recent")).toBeLessThan(
      requested.indexOf("ses_old"),
    );
  });

  it("admits persisted running children when status hydration fails", async () => {
    const children = Array.from({ length: 65 }, (_, index) => ({
      id: `ses_child_${index}`,
      parentID: "ses_parent",
      time: { created: index },
    }));
    let current = stateWith([
      child({
        id: "ses_child_0",
        targetSessionID: "ses_child_0",
        status: "running",
      }),
    ]);
    const requested: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-priority-"));
    const api = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(
            async ({ sessionID }: { readonly sessionID: string }) => ({
              data:
                sessionID === "ses_parent"
                  ? children.map((row) => ({ ...row, directory }))
                  : [],
            }),
          ),
          status: vi.fn(async () => {
            throw new Error("status unavailable");
          }),
          messages: vi.fn(async ({ sessionID }: { sessionID: string }) => {
            if (sessionID !== "ses_parent") requested.push(sessionID);
            return { data: [] };
          }),
        },
      },
    } satisfies RouteHydrationApi;

    await hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: (update) => {
        current = update(current);
      },
      options: { getCurrentState: () => current },
    });

    expect(requested).toHaveLength(65);
    expect(requested).toContain("ses_child_0");
    expect(current.children.ses_child_0?.status).toBe("running");
  });

  it("ignores a late route hydration result before state or persistence commits", async () => {
    const childMessages = deferred<{ data: unknown[] }>();
    const persistenceWrites: StatuslineState[] = [];
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ state }) => {
        persistenceWrites.push(state);
      },
    );
    const setState = vi.fn();
    let valid = true;
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-stale-"));
    const api = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(
            async ({ sessionID }: { readonly sessionID: string }) => ({
              data:
                sessionID === "ses_parent"
                  ? [{ id: "ses_child", parentID: "ses_parent", directory }]
                  : [],
            }),
          ),
          status: vi.fn(async () => ({ data: { ses_child: "running" } })),
          messages: vi.fn(({ sessionID }: { sessionID: string }) =>
            sessionID === "ses_parent"
              ? Promise.resolve({ data: [] })
              : childMessages.promise,
          ),
        },
      },
    } satisfies RouteHydrationApi;

    const hydration = hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState,
      persistenceCoordinator: persistence,
      options: { isValid: () => valid },
    });
    await vi.waitFor(() =>
      expect(api.client.session.messages).toHaveBeenCalledTimes(2),
    );
    valid = false;
    childMessages.resolve({ data: [] });

    expect(await hydration).toBe(false);
    expect(setState).not.toHaveBeenCalled();
    expect(persistenceWrites).toEqual([]);
    persistence.close();
  });

  it("aborts in-flight route child requests on lifecycle invalidation", async () => {
    const controller = new AbortController();
    const setState = vi.fn();
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-abort-"));
    const api = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(
            async ({ sessionID }: { readonly sessionID: string }) => ({
              data:
                sessionID === "ses_parent"
                  ? [{ id: "ses_child", parentID: "ses_parent", directory }]
                  : [],
            }),
          ),
          status: vi.fn(async () => ({ data: { ses_child: "running" } })),
          messages: vi.fn(
            (
              { sessionID }: { sessionID: string },
              options?: { signal?: AbortSignal },
            ) => {
              if (sessionID === "ses_parent") {
                return Promise.resolve({ data: [] });
              }
              return new Promise<{ data: unknown[] }>((_resolve, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("aborted")),
                  { once: true },
                );
              });
            },
          ),
        },
      },
    } satisfies RouteHydrationApi;

    const hydration = hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState,
      options: { signal: controller.signal },
    });
    await vi.waitFor(() =>
      expect(api.client.session.messages).toHaveBeenCalledTimes(2),
    );
    controller.abort();

    expect(await hydration).toBe(false);
    expect(setState).not.toHaveBeenCalled();
  });

  it.each(["children", "status", "messages"] as const)(
    "settles promptly when an aborted %s request ignores its signal",
    async (blockedRead) => {
      const controller = new AbortController();
      const directory = await mkdtemp(join(tmpdir(), "subagent-tui-abort-race-"));
      const never = new Promise<{ readonly data?: unknown }>(() => undefined);
      const blockedRequestStarted = deferred<void>();
      const children = vi.fn(
        async ({ sessionID }: { readonly sessionID: string }) => {
          if (blockedRead === "children") {
            blockedRequestStarted.resolve(undefined);
            return never;
          }
          return {
            data:
              sessionID === "ses_parent"
                ? [{ id: "ses_child", parentID: "ses_parent", directory }]
                : [],
          };
        },
      );
      const status = vi.fn(async () => {
        if (blockedRead === "status") {
          blockedRequestStarted.resolve(undefined);
          return never;
        }
        return { data: { ses_child: { status: "running" } } };
      });
      const messages = vi.fn(async () => {
        if (blockedRead === "messages") {
          blockedRequestStarted.resolve(undefined);
          return never;
        }
        return { data: [] };
      });
      const api: RouteHydrationApi = {
        state: { path: { directory } },
        client: { session: { children, status, messages } },
      };
      const hydration = hydratePreviousSubagents({
        api,
        currentSessionID: "ses_parent",
        statePath: join(directory, "state.json"),
        textPath: join(directory, "status.txt"),
        setState: () => undefined,
        options: { signal: controller.signal },
      });
      await blockedRequestStarted.promise;

      controller.abort();
      await expect(hydration).resolves.toBe(false);
    },
  );

  it("retries after aborting a non-cooperative message request", async () => {
    // Given
    const firstController = new AbortController();
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-abort-retry-"));
    const requestStarted = deferred<void>();
    let rejectLateRequest: (reason: Error) => void = () => undefined;
    const blockedRequest = new Promise<{ readonly data: readonly unknown[] }>(
      (_resolve, reject) => {
        rejectLateRequest = reject;
      },
    );
    let blockChildMessages = true;
    const api: RouteHydrationApi = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(async ({ sessionID }) => ({
            data:
              sessionID === "ses_parent"
                ? [{ id: "ses_child", parentID: "ses_parent", directory }]
                : [],
          })),
          status: vi.fn(async () => ({
            data: { ses_child: { status: "running" } },
          })),
          messages: vi.fn(async ({ sessionID }) => {
            if (sessionID !== "ses_child" || !blockChildMessages) {
              return { data: [] };
            }
            requestStarted.resolve(undefined);
            return blockedRequest;
          }),
        },
      },
    };
    const firstSetState = vi.fn();
    const firstHydration = hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: firstSetState,
      options: { signal: firstController.signal },
    });
    await requestStarted.promise;

    // When
    firstController.abort();
    const firstResult = await firstHydration;
    rejectLateRequest(new Error("late request rejection"));
    blockChildMessages = false;
    let current = stateWith([]);
    const retryResult = await hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: (update) => {
        current = update(current);
      },
    });

    // Then
    expect(firstResult).toBe(false);
    expect(firstSetState).not.toHaveBeenCalled();
    expect(retryResult).toBe(true);
    expect(current.children).toHaveProperty("ses_child");
  });

  it("preserves stale same-route updates against each child's baseline", async () => {
    const childMessages = deferred<{ readonly data: readonly unknown[] }>();
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-baseline-"));
    const liveUpdatedAt = new Date().toISOString();
    let current = stateWith([
      child({
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        model: { providerID: "openai", modelID: "baseline" },
        tokens: { input: 1, total: 1 },
      }),
    ]);
    const writes: StatuslineState[] = [];
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ state }) => {
        writes.push(structuredClone(state));
      },
    );
    const api: RouteHydrationApi = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(async ({ sessionID }) => ({
            data:
              sessionID === "ses_parent"
                ? [{ id: "ses_child", parentID: "ses_parent", directory }]
                : [],
          })),
          status: vi.fn(async () => ({
            data: { ses_child: { status: "idle" } },
          })),
          messages: vi.fn(({ sessionID }) =>
            sessionID === "ses_child"
              ? childMessages.promise
              : Promise.resolve({ data: [] }),
          ),
        },
      },
    };
    const hydration = hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: (update) => {
        current = update(current);
      },
      persistenceCoordinator: persistence,
      options: { getCurrentState: () => current },
    });
    await vi.waitFor(() =>
      expect(api.client.session?.messages).toHaveBeenCalledTimes(2),
    );
    current = stateWith([
      child({
        status: "error",
        color: "red",
        endedAt: liveUpdatedAt,
        updatedAt: liveUpdatedAt,
        model: { providerID: "anthropic", modelID: "live" },
        tokens: { input: 7, total: 7 },
      }),
    ]);
    childMessages.resolve({
      data: [
        {
          sessionID: "ses_child",
          role: "assistant",
          providerID: "openai",
          modelID: "hydrated",
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
          time: { created: 1 },
        },
      ],
    });

    await hydration;

    expect(current.children.ses_child).toMatchObject({
      status: "error",
      endedAt: liveUpdatedAt,
      model: { providerID: "anthropic", modelID: "live" },
      tokens: { input: 7, output: 4, total: 7 },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(structuredClone(current));
    persistence.close();
  });

  it("preserves live metadata while stale hydration backfills missing evidence", async () => {
    // Given
    const childMessages = deferred<{ readonly data: readonly unknown[] }>();
    const childRequestStarted = deferred<void>();
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-metadata-"));
    const baselineUpdatedAt = "2026-04-30T10:01:00.000Z";
    const liveUpdatedAt = "2026-04-30T10:03:00.000Z";
    let current = stateWith([
      child({
        title: "Baseline title",
        updatedAt: baselineUpdatedAt,
        model: { providerID: "openai", modelID: "baseline" },
        tokens: { input: 1, total: 1 },
      }),
    ]);
    const writes: StatuslineState[] = [];
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ state }) => {
        writes.push(structuredClone(state));
      },
    );
    const api: RouteHydrationApi = {
      state: { path: { directory } },
      client: {
        session: {
          children: vi.fn(async ({ sessionID }) => ({
            data:
              sessionID === "ses_parent"
                ? [
                    {
                      id: "ses_child",
                      parentID: "ses_parent",
                      directory,
                      title: "Stale hydrated title",
                      time: { updated: baselineUpdatedAt },
                    },
                  ]
                : [],
          })),
          status: vi.fn(async () => ({
            data: { ses_child: { status: "running" } },
          })),
          messages: vi.fn(({ sessionID }) => {
            if (sessionID !== "ses_child") return Promise.resolve({ data: [] });
            childRequestStarted.resolve(undefined);
            return childMessages.promise;
          }),
        },
      },
    };
    const hydration = hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: (update) => {
        current = update(current);
      },
      persistenceCoordinator: persistence,
      options: { getCurrentState: () => current },
    });
    await childRequestStarted.promise;
    current = stateWith([
      child({
        title: "Live title",
        updatedAt: liveUpdatedAt,
        model: { providerID: "openai", modelID: "baseline" },
        tokens: { input: 1, total: 1 },
      }),
    ]);

    // When
    childMessages.resolve({
      data: [
        {
          sessionID: "ses_child",
          role: "assistant",
          providerID: "openai",
          modelID: "hydrated",
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
          time: { created: 1 },
        },
      ],
    });
    await hydration;

    // Then
    expect(current.children.ses_child).toMatchObject({
      title: "Live title",
      updatedAt: liveUpdatedAt,
      model: { providerID: "openai", modelID: "hydrated" },
      tokens: { input: 3, output: 4, total: 7 },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(structuredClone(current));
    persistence.close();
  });

  it("persists every changed target-linked alias ID exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-changed-"));
    let current = stateWith([
      child(),
      child({
        id: "tool:alias",
        source: "tool",
        targetSessionID: "ses_child",
      }),
    ]);
    let persistedChangedIDs: readonly string[] | undefined;
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ changedChildIDs }) => {
        persistedChangedIDs = changedChildIDs;
      },
    );
    const fixture = createHydrationApi({
      directory,
      graph: {
        ses_parent: [{ id: "ses_child", parentID: "ses_parent", directory }],
        ses_child: [],
      },
      statuses: { ses_child: { status: "idle" } },
      messages: {
        ses_child: [
          {
            sessionID: "ses_child",
            role: "assistant",
            providerID: "openai",
            modelID: "hydrated-model",
            time: { created: 1 },
          },
        ],
      },
    });

    await hydratePreviousSubagents({
      api: fixture.api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: (update) => {
        current = update(current);
      },
      persistenceCoordinator: persistence,
      options: { getCurrentState: () => current },
    });

    expect(current.children.ses_child?.status).toBe("done");
    expect(current.children["tool:alias"]?.status).toBe("done");
    expect(current.children.ses_child?.model?.modelID).toBe("hydrated-model");
    expect(current.children["tool:alias"]?.model?.modelID).toBe(
      "hydrated-model",
    );
    expect([...(persistedChangedIDs ?? [])].sort()).toEqual([
      "ses_child",
      "tool:alias",
    ]);
    persistence.close();
  });

  it("uses full persistence refresh when hydration prunes retained state", async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-prune-"));
    let current = stateWith([
      child(),
      child({
        id: "ses_stale",
        parentID: "ses_other",
        targetSessionID: "ses_stale",
        status: "done",
        color: "green",
        updatedAt: "2020-01-01T00:00:00.000Z",
        endedAt: "2020-01-01T00:00:00.000Z",
      }),
    ]);
    let writes = 0;
    let persistedChangedIDs: unknown = "not-written";
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ changedChildIDs }) => {
        writes += 1;
        persistedChangedIDs = changedChildIDs;
      },
    );
    const fixture = createHydrationApi({
      directory,
      graph: {
        ses_parent: [{ id: "ses_child", parentID: "ses_parent", directory }],
        ses_child: [],
      },
      statuses: { ses_child: { status: "running" } },
    });

    // When
    await hydratePreviousSubagents({
      api: fixture.api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState: (update) => {
        current = update(current);
      },
      persistenceCoordinator: persistence,
      options: { getCurrentState: () => current },
    });

    // Then
    expect(current.children).not.toHaveProperty("ses_stale");
    expect(writes).toBe(1);
    expect(persistedChangedIDs).toBeUndefined();
    persistence.close();
  });

  it("commits verified descendants once while reporting a failed branch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-partial-"));
    let current = stateWith([]);
    const writes: StatuslineState[] = [];
    const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
      async ({ state }) => {
        writes.push(state);
      },
    );
    const children = vi.fn(async ({ sessionID }: { readonly sessionID: string }) => {
      if (sessionID === "ses_parent") {
        return {
          data: [
            { id: "ses_good", parentID: "ses_parent", directory },
            { id: "ses_bad", parentID: "ses_parent", directory },
            { id: "ses_wrong", parentID: "ses_other", directory },
          ],
        };
      }
      if (sessionID === "ses_bad") throw new Error("branch unavailable");
      if (sessionID === "ses_good") {
        return {
          data: [{ id: "ses_grand", parentID: "ses_good", directory }],
        };
      }
      return { data: [] };
    });
    const api: RouteHydrationApi = {
      state: { path: { directory } },
      client: {
        session: {
          children,
          status: vi.fn(async () => ({
            data: {
              ses_good: { status: "running" },
              ses_grand: { status: "running" },
            },
          })),
          messages: vi.fn(async () => ({ data: [] })),
        },
      },
    };
    const setState = vi.fn((update: (state: StatuslineState) => StatuslineState) => {
      current = update(current);
    });

    const hydrated = await hydratePreviousSubagents({
      api,
      currentSessionID: "ses_parent",
      statePath: join(directory, "state.json"),
      textPath: join(directory, "status.txt"),
      setState,
      persistenceCoordinator: persistence,
      options: { getCurrentState: () => current },
    });

    expect(hydrated).toBe(false);
    expect(current.children).toHaveProperty("ses_good");
    expect(current.children).toHaveProperty("ses_grand");
    expect(current.children).not.toHaveProperty("ses_wrong");
    expect(current.children).not.toHaveProperty("ses_bad");
    expect(
      children.mock.calls.filter(([request]) => request.sessionID === "ses_bad"),
    ).toHaveLength(1);
    expect(children).toHaveBeenCalledTimes(4);
    expect(setState).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    persistence.close();
  });

  it("preserves an existing running row when parent-message evidence fails", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          source: "session",
          targetSessionID: "ses_child_running",
          status: "running",
        }),
      ],
      children: [
        {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      statuses: {},
      failMessagesFor: ["ses_parent"],
    });

    expect(state.children.ses_child_running?.status).toBe("running");
  });

  it("preserves an existing current-session running row when status hydration fails", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          source: "session",
          targetSessionID: "ses_child_running",
          status: "running",
        }),
      ],
      children: [
        {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      messagesBySession: {
        ses_parent: [],
        ses_child_running: [],
      },
      failStatus: true,
    });

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(state.children.ses_child_running?.status).toBe("running");
    expect(snapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_child_running",
    ]);
  });

  it("hydrates a visible running row when child status is explicitly busy", async () => {
    const state = await hydrateWith({
      children: [
        {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      statuses: { ses_child_running: { status: "busy" } },
    });

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(snapshot.visibleRows.map(({ child: item }) => item.id)).toEqual([
      "ses_child_running",
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 1, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(1);
  });

  it("hydrates terminal child statuses without leaving them running", async () => {
    const updatedAt = new Date().toISOString();
    const state = await hydrateWith({
      children: [
        {
          id: "ses_child_done",
          parentID: "ses_parent",
          title: "Done child",
          time: {
            created: "2026-04-30T10:00:00.000Z",
            updated: updatedAt,
          },
        },
      ],
      statuses: { ses_child_done: { status: "idle" } },
    });

    expect(state.children.ses_child_done?.status).toBe("done");
    expect(state.children.ses_child_done?.endedAt).toBe(updatedAt);
  });
});

describe("registerSubagentCommands", () => {
  it("registers both keymap and legacy commands when both APIs are available", () => {
    const keymapDispose = vi.fn();
    const legacyDispose = vi.fn();
    const registerLayer = vi.fn((_layer: KeymapLayer) => keymapDispose);
    const commandRegister = vi.fn(
      (_commands: LegacyCommandFactory) => legacyDispose,
    );
    const toggleSection = vi.fn();
    const focusSidebarList = vi.fn();
    const toggleCompletedHistory = vi.fn();

    const result = registerSubagentCommands({
      api: {
        keymap: { registerLayer },
        command: { register: commandRegister },
      },
      sectionEnabled: () => true,
      toggleSection,
      focusSidebarList,
      toggleCompletedHistory,
    });

    expect(commandRegister).toHaveBeenCalledOnce();
    expect(registerLayer).toHaveBeenCalledOnce();
    expect(registerLayer).toHaveBeenCalledWith({
      commands: [
        expect.objectContaining({
          name: "subagent-statusline.toggle-sidebar-section",
          title: expect.stringContaining("Subagents"),
          run: expect.any(Function),
        }),
        expect.objectContaining({
          name: "subagent-statusline.focus-sidebar-list",
          title: "Subagents: Focus sidebar list",
          run: expect.any(Function),
        }),
        expect.objectContaining({
          name: "subagent-statusline.toggle-completed-history",
          title: "Subagents: Toggle completed history",
          run: expect.any(Function),
        }),
      ],
      bindings: [
        {
          key: "alt+b",
          cmd: "subagent-statusline.focus-sidebar-list",
        },
      ],
    });

    const layer = registerLayer.mock.calls[0]?.[0];
    layer?.commands?.[0]?.run();
    layer?.commands?.[1]?.run();
    layer?.commands?.[2]?.run();

    const legacyCommands = commandRegister.mock.calls[0]?.[0]?.();
    legacyCommands?.[0]?.onSelect?.();
    legacyCommands?.[1]?.onSelect?.();
    legacyCommands?.[2]?.onSelect?.();

    expect(toggleSection).toHaveBeenNthCalledWith(1, false);
    expect(toggleSection).toHaveBeenNthCalledWith(2, false);
    expect(focusSidebarList).toHaveBeenCalledTimes(2);
    expect(toggleCompletedHistory).toHaveBeenCalledTimes(2);

    expect(legacyCommands).toEqual([
      expect.objectContaining({
        value: "subagent-statusline.toggle-sidebar-section",
        description: "Toggle the entire subagent sidebar section",
        category: "Subagents",
      }),
      expect.objectContaining({
        title: "Subagents: Focus sidebar list",
        value: "subagent-statusline.focus-sidebar-list",
        keybind: "alt+b",
      }),
      expect.objectContaining({
        title: "Subagents: Toggle completed history",
        value: "subagent-statusline.toggle-completed-history",
        description: expect.stringContaining("Shortcut: c"),
      }),
    ]);

    result();
    expect(keymapDispose).toHaveBeenCalledOnce();
    expect(legacyDispose).toHaveBeenCalledOnce();

    result();
    expect(keymapDispose).toHaveBeenCalledOnce();
    expect(legacyDispose).toHaveBeenCalledOnce();
  });

  it("registers only keymap when legacy API is unavailable", () => {
    const dispose = vi.fn();
    const registerLayer = vi.fn((_layer: KeymapLayer) => dispose);
    const toggleSection = vi.fn();
    const focusSidebarList = vi.fn();
    const toggleCompletedHistory = vi.fn();

    const result = registerSubagentCommands({
      api: {
        keymap: { registerLayer },
      },
      sectionEnabled: () => true,
      toggleSection,
      focusSidebarList,
      toggleCompletedHistory,
    });

    expect(registerLayer).toHaveBeenCalledOnce();
    const layer = registerLayer.mock.calls[0]?.[0];
    expect(layer?.bindings).toEqual([
      {
        key: "alt+b",
        cmd: "subagent-statusline.focus-sidebar-list",
      },
    ]);

    layer?.commands?.[0]?.run();
    layer?.commands?.[1]?.run();
    layer?.commands?.[2]?.run();
    expect(toggleSection).toHaveBeenCalledWith(false);
    expect(focusSidebarList).toHaveBeenCalledOnce();
    expect(toggleCompletedHistory).toHaveBeenCalledOnce();

    result();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("falls back to the legacy command API when keymap is unavailable", () => {
    const dispose = vi.fn();
    const register = vi.fn((_commands: LegacyCommandFactory) => dispose);
    const toggleSection = vi.fn();
    const focusSidebarList = vi.fn();
    const toggleCompletedHistory = vi.fn();

    const result = registerSubagentCommands({
      api: { command: { register } },
      sectionEnabled: () => false,
      toggleSection,
      focusSidebarList,
      toggleCompletedHistory,
    });

    expect(register).toHaveBeenCalledOnce();
    const legacyCommands = register.mock.calls[0]?.[0]?.();
    expect(legacyCommands).toEqual([
      expect.objectContaining({
        title: "Subagents: Enable sidebar section",
        value: "subagent-statusline.toggle-sidebar-section",
      }),
      expect.objectContaining({
        value: "subagent-statusline.focus-sidebar-list",
        keybind: "alt+b",
      }),
      expect.objectContaining({
        value: "subagent-statusline.toggle-completed-history",
        description: expect.stringContaining("sidebar list is focused"),
      }),
    ]);

    legacyCommands?.[0]?.onSelect?.();
    legacyCommands?.[1]?.onSelect?.();
    legacyCommands?.[2]?.onSelect?.();
    expect(toggleSection).toHaveBeenCalledWith(true);
    expect(focusSidebarList).toHaveBeenCalledOnce();
    expect(toggleCompletedHistory).toHaveBeenCalledOnce();

    result();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns a safe no-op disposer when neither API is available", () => {
    const result = registerSubagentCommands({
      api: {},
      sectionEnabled: () => false,
      toggleSection: vi.fn(),
      focusSidebarList: vi.fn(),
      toggleCompletedHistory: vi.fn(),
    });

    expect(() => result()).not.toThrow();
    expect(() => result()).not.toThrow();
  });

  it("disposes all created registrations even if one dispose throws", () => {
    const keymapDispose = vi.fn(() => {
      throw new Error("keymap dispose failed");
    });
    const legacyDispose = vi.fn();
    const registerLayer = vi.fn((_layer: KeymapLayer) => keymapDispose);
    const register = vi.fn(
      (_commands: LegacyCommandFactory) => legacyDispose,
    );

    const result = registerSubagentCommands({
      api: {
        keymap: { registerLayer },
        command: { register },
      },
      sectionEnabled: () => false,
      toggleSection: vi.fn(),
      focusSidebarList: vi.fn(),
      toggleCompletedHistory: vi.fn(),
    });

    expect(() => result()).not.toThrow();
    expect(keymapDispose).toHaveBeenCalledOnce();
    expect(legacyDispose).toHaveBeenCalledOnce();

    result();
    expect(keymapDispose).toHaveBeenCalledOnce();
    expect(legacyDispose).toHaveBeenCalledOnce();
  });
});

describe("TUI lifecycle cleanup", () => {
  it("continues after first and middle disposer failures and stays idempotent", () => {
    const invalidated = vi.fn();
    const first = vi.fn(() => {
      throw new Error("first cleanup failed");
    });
    const middle = vi.fn(() => {
      throw new Error("middle cleanup failed");
    });
    const root = vi.fn();
    const report = vi.fn();
    const dispose = createBestEffortDisposer(
      [invalidated, first, middle, root],
      report,
    );

    expect(() => dispose()).not.toThrow();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(middle).toHaveBeenCalledOnce();
    expect(root).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledTimes(2);

    dispose();
    expect(root).toHaveBeenCalledOnce();
  });

  it("clears managed focus and sidebar callbacks before they can call stale UI", () => {
    vi.useFakeTimers();
    const focus = vi.fn();
    const toggleHistory = vi.fn();
    const deferredCallbacks = createManagedDeferredCallbacks();

    deferredCallbacks.schedule(focus);
    deferredCallbacks.schedule(toggleHistory);
    deferredCallbacks.dispose();
    vi.runAllTimers();

    expect(focus).not.toHaveBeenCalled();
    expect(toggleHistory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("running reconciliation candidate selection", () => {
  it("selects a deep route descendant before an over-budget unrelated backlog", () => {
    // Given
    const unrelated = Array.from({ length: 9 }, (_, index) =>
      child({
        id: `ses_unrelated_${index}`,
        parentID: "ses_other_root",
        targetSessionID: `ses_unrelated_${index}`,
        updatedAt: `2026-07-17T09:19:${(50 + index).toString()}.000Z`,
      }),
    );
    const state = stateWith([
      ...unrelated,
      child({
        id: "ses_child",
        parentID: "ses_root",
        targetSessionID: "ses_child",
        status: "done",
        color: "green",
      }),
      child({
        id: "ses_grand",
        parentID: "ses_child",
        targetSessionID: "ses_grand",
        status: "done",
        color: "green",
      }),
      child({
        id: "ses_deep",
        parentID: "ses_grand",
        targetSessionID: "ses_deep",
        updatedAt: "2026-07-17T09:18:00.000Z",
      }),
    ]);
    const routeSnapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_root",
    });

    // When
    const selected = selectRunningReconcileCandidates({
      state,
      currentSessionID: "ses_root",
      currentRouteDescendantSessionIDs: routeSnapshot.descendantSessionIDs,
      nowMs: Date.parse("2026-07-17T09:20:00.000Z"),
      maxCandidates: 1,
    });

    // Then
    expect(selected.map(({ childID }) => childID)).toEqual(["ses_deep"]);
  });

  it("prioritizes all current-route descendants for running reconciliation", () => {
    // Given
    const state = stateWith([
      child({
        id: "ses_other",
        parentID: "ses_other_root",
        targetSessionID: "ses_other",
        updatedAt: "2026-07-17T09:19:30.000Z",
      }),
      child({
        id: "ses_child",
        parentID: "ses_root",
        targetSessionID: "ses_child",
        updatedAt: "2026-07-17T09:19:00.000Z",
      }),
      child({
        id: "ses_grand",
        parentID: "ses_child",
        targetSessionID: "ses_grand",
        updatedAt: "2026-07-17T09:18:00.000Z",
      }),
    ]);

    // When
    const selected = selectRunningReconcileCandidates({
      state,
      currentSessionID: "ses_root",
      hydratingSessionIDs: new Set(),
      nowMs: Date.parse("2026-07-17T09:20:00.000Z"),
      maxCandidates: 3,
    });

    // Then
    expect(selected.slice(0, 2).map(({ childID }) => childID)).toEqual([
      "ses_child",
      "ses_grand",
    ]);
  });

  it("suppresses current-route children only while that route is hydrating", () => {
    const nowMs = Date.parse("2026-07-17T09:20:00.000Z");
    const current = child({
      id: "ses_current_child",
      targetSessionID: "ses_current_child",
      parentID: "ses_current",
      updatedAt: "2026-07-17T09:19:00.000Z",
    });
    const oldGlobal = child({
      id: "ses_old_global",
      targetSessionID: "ses_old_global",
      parentID: "ses_other",
      startedAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T08:00:00.000Z",
    });

    const selected = selectRunningReconcileCandidates({
      state: stateWith([current, oldGlobal]),
      currentSessionID: "ses_current",
      hydratingSessionIDs: new Set(["ses_current"]),
      nowMs,
      maxCandidates: 8,
    });

    expect(selected.map((candidate) => candidate.childID)).toEqual([
      "ses_old_global",
    ]);
  });

  it("does not suppress current-route reconciliation after hydration ends", () => {
    const nowMs = Date.parse("2026-07-17T09:20:00.000Z");
    const current = child({
      id: "ses_current_child",
      targetSessionID: "ses_current_child",
      parentID: "ses_current",
      updatedAt: "2026-07-17T09:19:00.000Z",
    });

    const selected = selectRunningReconcileCandidates({
      state: stateWith([current]),
      currentSessionID: "ses_current",
      hydratingSessionIDs: new Set(),
      nowMs,
      maxCandidates: 8,
    });

    expect(selected.map((candidate) => candidate.childID)).toEqual([
      "ses_current_child",
    ]);
  });
});

describe("bounded token hydration", () => {
  it("admits a late deep route descendant before an over-limit unrelated backlog", async () => {
    // Given
    const unrelated = Array.from(
      { length: TOKEN_HYDRATION_ADMISSION_LIMIT + 1 },
      (_, index) =>
        child({
          id: `ses_unrelated_${index}`,
          parentID: "ses_other_root",
          targetSessionID: `ses_unrelated_${index}`,
          updatedAt: "2026-07-17T09:19:30.000Z",
        }),
    );
    const deep = child({
      id: "ses_deep",
      parentID: "ses_grand",
      targetSessionID: "ses_deep",
      updatedAt: "2026-07-17T09:18:00.000Z",
    });
    const state = stateWith([
      ...unrelated,
      child({
        id: "ses_child",
        parentID: "ses_root",
        targetSessionID: "ses_child",
        status: "done",
        color: "green",
        tokens: { total: 1 },
      }),
      child({
        id: "ses_grand",
        parentID: "ses_child",
        targetSessionID: "ses_grand",
        status: "done",
        color: "green",
        tokens: { total: 1 },
      }),
      deep,
    ]);
    const routeSnapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_root",
    });
    const requested: string[] = [];
    const queue = createTokenHydrationQueue({
      hydrate: async ({ childID }) => {
        requested.push(childID);
        return undefined;
      },
      commit: () => undefined,
      onError: () => undefined,
    });
    const candidates = prioritizeTokenHydrationCandidates(
      Object.values(state.children).filter(
        (candidate) =>
          candidate.status === "running" || candidate.tokens?.total === undefined,
      ),
      routeSnapshot.descendantSessionIDs,
    );

    // When
    for (const candidate of candidates) {
      queue.enqueue({ childID: candidate.id, baseline: undefined });
    }
    await queue.idle();

    // Then
    expect(requested).toHaveLength(TOKEN_HYDRATION_ADMISSION_LIMIT);
    expect(requested[0]).toBe("ses_deep");
    queue.dispose();
  });

  it("prioritizes every current-route descendant for token admission", () => {
    // Given
    const state = stateWith([
      child({
        id: "ses_other",
        parentID: "ses_other_root",
        targetSessionID: "ses_other",
        updatedAt: "2026-07-17T09:19:30.000Z",
      }),
      child({
        id: "ses_child",
        parentID: "ses_root",
        targetSessionID: "ses_child",
        updatedAt: "2026-07-17T09:19:00.000Z",
      }),
      child({
        id: "ses_grand",
        parentID: "ses_child",
        targetSessionID: "ses_grand",
        updatedAt: "2026-07-17T09:18:00.000Z",
      }),
    ]);
    const snapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_root",
    });

    // When
    const selected = prioritizeTokenHydrationCandidates(
      Object.values(state.children),
      snapshot.descendantSessionIDs,
    );

    // Then
    expect(selected.slice(0, 2).map(({ id }) => id)).toEqual([
      "ses_child",
      "ses_grand",
    ]);
  });

  it("deduplicates duplicate token jobs while work is queued or running", async () => {
    const gate = deferred<{ total: number }>();
    const hydrate = vi.fn(() => gate.promise);
    const commit = vi.fn();
    const queue = createTokenHydrationQueue({
      hydrate,
      commit,
      onError: vi.fn(),
    });

    expect(queue.enqueue({ childID: "ses_child", baseline: undefined })).toBe(
      true,
    );
    expect(queue.enqueue({ childID: "ses_child", baseline: undefined })).toBe(
      false,
    );
    expect(hydrate).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(hydrate).toHaveBeenCalledOnce();
    gate.resolve({ total: 10 });
    await queue.idle();

    expect(hydrate).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    queue.dispose();
  });

  it("ignores late token results after route invalidation or disposal", async () => {
    const gate = deferred<{ total: number }>();
    const commit = vi.fn();
    let valid = true;
    const queue = createTokenHydrationQueue({
      hydrate: () => gate.promise,
      commit,
      onError: vi.fn(),
      isValid: () => valid,
    });
    queue.enqueue({ childID: "ses_child", baseline: undefined });
    await Promise.resolve();
    valid = false;
    queue.dispose();
    gate.resolve({ total: 10 });
    await queue.idle();

    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves newer event token fields when a late backfill completes", () => {
    const baseline = { input: 1, output: 2 };

    expect(
      mergeFreshHydratedTokens(
        { input: 7, output: 2 },
        baseline,
        { input: 3, output: 4, total: 7 },
      ),
    ).toEqual({ input: 7, output: 4, total: 7 });
  });

  it("returns undefined when no token field is resolvable", () => {
    expect(
      mergeFreshHydratedTokens(undefined, undefined, {}),
    ).toBeUndefined();
    expect(
      mergeFreshHydratedTokens(undefined, undefined, {
        input: undefined,
        output: undefined,
        total: undefined,
        contextPercent: undefined,
      }),
    ).toBeUndefined();
  });

  it("stops retry scheduling after exactly six failed hydration attempts", () => {
    const schedule = vi.fn();
    let attempts = 0;

    for (let failure = 0; failure < 6; failure += 1) {
      attempts = scheduleHydrateRetry({ attempts, schedule });
    }

    expect(attempts).toBe(6);
    expect(schedule).toHaveBeenCalledTimes(5);
    scheduleHydrateRetry({ attempts, schedule });
    expect(schedule).toHaveBeenCalledTimes(5);
  });
});

describe("resolveSidebarReturnFocusAction", () => {
  const pendingSidebarRefocus = {
    parentSessionID: "parent",
    childSessionID: "child",
    childRowID: "row-1",
  };

  it("returns focus-prompt for remembered child -> parent return", () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus,
        previousRouteSessionID: "child",
        routeSessionID: "parent",
      }),
    ).toBe("focus-prompt");
  });

  it("returns focus-prompt while preserving showCompletedHistory", () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus: {
          ...pendingSidebarRefocus,
          showCompletedHistory: true,
        },
        previousRouteSessionID: "child",
        routeSessionID: "parent",
      }),
    ).toBe("focus-prompt");
  });

  it("returns prompt focus from a grandchild to its immediate parent", () => {
    // Given / When
    const action = resolveSidebarReturnFocusAction({
      pendingSidebarRefocus: {
        parentSessionID: "ses_child",
        childSessionID: "ses_grand",
        childRowID: "ses_grand",
      },
      previousRouteSessionID: "ses_grand",
      routeSessionID: "ses_child",
    });

    // Then
    expect(action).toBe("focus-prompt");
  });

  it("returns clear-pending when route leaves remembered child path", () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus,
        previousRouteSessionID: "child",
        routeSessionID: "another",
      }),
    ).toBe("clear-pending");
  });

  it("returns none for unrelated transitions while still on child", () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus,
        previousRouteSessionID: "parent",
        routeSessionID: "child",
      }),
    ).toBe("none");
  });

  it("returns none when no pending sidebar navigation exists", () => {
    expect(
      resolveSidebarReturnFocusAction({
        previousRouteSessionID: "child",
        routeSessionID: "parent",
      }),
    ).toBe("none");
  });
});

describe("shouldReleaseSidebarListFocus", () => {
  it("releases active list focus when the last running subagent completes", () => {
    expect(
      shouldReleaseSidebarListFocus({
        previousRunningCount: 1,
        runningCount: 0,
        listFocusModeActive: true,
      }),
    ).toBe(true);
  });

  it("preserves list focus without a running-to-terminal transition", () => {
    expect(
      shouldReleaseSidebarListFocus({
        previousRunningCount: 0,
        runningCount: 0,
        listFocusModeActive: true,
      }),
    ).toBe(false);
    expect(
      shouldReleaseSidebarListFocus({
        previousRunningCount: 1,
        runningCount: 0,
        listFocusModeActive: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSiblingSidebarRefocus", () => {
  const pendingSidebarRefocus = {
    parentSessionID: "parent",
    childSessionID: "child-a",
    childRowID: "row-a",
  };

  it("returns updated child row ID when navigating to a sibling subagent", () => {
    expect(
      resolveSiblingSidebarRefocus({
        pendingSidebarRefocus,
        routeSessionID: "child-b",
        children: {
          "row-a": { id: "row-a", parentID: "parent", targetSessionID: "child-a" },
          "row-b": { id: "row-b", parentID: "parent", targetSessionID: "child-b" },
        },
      }),
    ).toEqual({ childSessionID: "child-b", childRowID: "row-b" });
  });

  it("returns undefined when route returns to parent", () => {
    expect(
      resolveSiblingSidebarRefocus({
        pendingSidebarRefocus,
        routeSessionID: "parent",
        children: {
          "row-a": { id: "row-a", parentID: "parent", targetSessionID: "child-a" },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when route stays on recorded child", () => {
    expect(
      resolveSiblingSidebarRefocus({
        pendingSidebarRefocus,
        routeSessionID: "child-a",
        children: {
          "row-a": { id: "row-a", parentID: "parent", targetSessionID: "child-a" },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when target session is not a sibling", () => {
    expect(
      resolveSiblingSidebarRefocus({
        pendingSidebarRefocus,
        routeSessionID: "other-child",
        children: {
          "row-a": { id: "row-a", parentID: "parent", targetSessionID: "child-a" },
          "row-other": { id: "row-other", parentID: "other-parent", targetSessionID: "other-child" },
        },
      }),
    ).toBeUndefined();
  });
});

describe("focusPromptWithDeferredRetry", () => {
  it("retries once when prompt focus is initially unavailable", () => {
    const queue: Array<() => void> = [];
    const schedule = (callback: () => void): void => {
      queue.push(callback);
    };
    let hasPromptRef = false;
    const focus = vi.fn(() => {
      if (!hasPromptRef) {
        hasPromptRef = true;
        return false;
      }
      return true;
    });

    focusPromptWithDeferredRetry(focus, schedule);
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
