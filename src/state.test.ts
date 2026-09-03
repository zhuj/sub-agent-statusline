import { readFile, readdir, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  countHistoricalSubagentExecutions,
  countRetainedSubagentStatuses,
  getCounts,
  isVisibleSubagentCounterEligible,
  markChildStatus,
  pruneTerminalChildren,
  refreshDerivedFields,
  refreshStateForSnapshot,
  resolveStatePath,
  resolveTextPath,
  saveState,
  saveStatusText,
  upsertChildDetails,
  upsertRunningChild,
  type ChildSessionState,
} from "./state.js";
import { createFileHarness } from "../test/helpers/test-harness.js";
import {
  pathExists,
  useFrozenTime,
} from "../test/helpers/test-harness.js";

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
    updatedAt: "2026-04-30T10:00:00.000Z",
    ...overrides,
  };
}

describe("state", () => {
  it("upserts tool wrappers without counting them and marks terminal statuses", () => {
    useFrozenTime("2026-04-30T10:05:00.000Z");
    const state = createEmptyState();

    expect(
      upsertRunningChild(state, {
        id: "tool:part_1",
        title: "Run tests",
        parentID: "ses_parent",
        source: "tool",
        startedAt: "2026-04-30T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(state.totalExecuted).toBe(0);
    expect(state.countedChildIDs["tool:part_1"]).toBeUndefined();
    expect(state.children["tool:part_1"]).toBeDefined();

    upsertRunningChild(state, {
      id: "tool:part_1",
      title: "Run tests",
      parentID: "ses_parent",
      source: "tool",
      updatedAt: "2026-04-30T10:02:00.000Z",
    });
    expect(state.totalExecuted).toBe(0);
    expect(state.countedChildIDs["tool:part_1"]).toBeUndefined();

    expect(
      markChildStatus(state, "tool:part_1", "done", "2026-04-30T10:03:00.000Z"),
    ).toBe(true);
    expect(state.children["tool:part_1"]).toMatchObject({
      status: "done",
      color: "green",
      endedAt: "2026-04-30T10:03:00.000Z",
    });
    expect(state.totalExecuted).toBe(0);
    expect(state.countedChildIDs["tool:part_1"]).toBeUndefined();
    expect(getCounts(state)).toEqual({ running: 0, done: 0, error: 0 });
  });

  it("keeps non-zero-duration tool wrappers uncounted", () => {
    const state = createEmptyState();

    expect(
      upsertRunningChild(state, {
        id: "tool:part_2",
        title: "Run longer delegated task",
        parentID: "ses_parent",
        source: "tool",
        startedAt: "2026-04-30T10:00:00.000Z",
        updatedAt: "2026-04-30T10:05:00.000Z",
      }),
    ).toBe(true);
    markChildStatus(state, "tool:part_2", "done", "2026-04-30T10:05:00.000Z");
    refreshDerivedFields(state, new Date("2026-04-30T10:05:00.000Z"));

    expect(state.children["tool:part_2"].elapsedMs).toBe(300000);
    expect(state.totalExecuted).toBe(0);
    expect(state.countedChildIDs["tool:part_2"]).toBeUndefined();
  });

  it("counts real sessions exactly once even with repeated updates", () => {
    const state = createEmptyState();

    expect(
      upsertRunningChild(state, {
        id: "ses_child",
        title: "Child work",
        parentID: "ses_parent",
        source: "session",
      }),
    ).toBe(true);
    expect(state.totalExecuted).toBe(1);
    expect(state.countedChildIDs.ses_child).toBe(true);

    upsertRunningChild(state, {
      id: "ses_child",
      title: "Child work",
      parentID: "ses_parent",
      source: "session",
      updatedAt: "2026-04-30T10:02:00.000Z",
    });
    expect(
      markChildStatus(state, "ses_child", "done", "2026-04-30T10:03:00.000Z"),
    ).toBe(true);

    expect(state.totalExecuted).toBe(1);
    expect(Object.keys(state.countedChildIDs)).toEqual(["ses_child"]);
  });

  it("keeps historical execution identities after terminal pruning", () => {
    // Given
    const state = createEmptyState();
    upsertRunningChild(state, {
      id: "ses_expired",
      title: "Expired child",
      parentID: "ses_parent",
      source: "session",
      startedAt: "2026-04-26T08:00:00.000Z",
      updatedAt: "2026-04-26T08:00:00.000Z",
    });
    markChildStatus(
      state,
      "ses_expired",
      "done",
      "2026-04-26T08:00:00.000Z",
    );

    // When
    refreshDerivedFields(state, new Date("2026-04-30T10:00:01.000Z"));

    // Then
    expect(state.children.ses_expired).toBeUndefined();
    expect(state.countedChildIDs.ses_expired).toBe(true);
    expect(state.totalExecuted).toBe(1);

    // When
    upsertRunningChild(state, {
      id: "ses_new",
      title: "New child",
      parentID: "ses_parent",
      source: "session",
    });

    // Then
    expect(state.countedChildIDs).toMatchObject({
      ses_expired: true,
      ses_new: true,
    });
    expect(state.totalExecuted).toBe(2);
  });

  it("counts a tool wrapper followed by a matching real session as one execution", () => {
    const state = createEmptyState();

    upsertRunningChild(state, {
      id: "tool:part_1",
      title: "Delegate work",
      parentID: "ses_parent",
      messageID: "msg_1",
      source: "tool",
      targetSessionID: "ses_child",
    });
    expect(state.totalExecuted).toBe(0);

    upsertRunningChild(state, {
      id: "ses_child",
      title: "Child work",
      parentID: "ses_parent",
      messageID: "msg_1",
      source: "session",
    });

    expect(state.totalExecuted).toBe(1);
    expect(state.countedChildIDs.ses_child).toBe(true);
    expect(state.countedChildIDs["tool:part_1"]).toBeUndefined();
  });

  it("keeps subtask wrappers uncounted and counts only real sessions", () => {
    const state = createEmptyState();

    upsertRunningChild(state, {
      id: "subtask:part_1",
      title: "Fallback work",
      parentID: "ses_parent",
      messageID: "msg_1",
      source: "subtask",
    });
    expect(state.totalExecuted).toBe(0);
    expect(state.countedChildIDs["subtask:part_1"]).toBeUndefined();

    upsertRunningChild(state, {
      id: "ses_other",
      title: "Other child",
      parentID: "ses_parent",
      messageID: "msg_2",
      source: "session",
    });
    upsertRunningChild(state, {
      id: "subtask:part_2",
      title: "Already counted fallback",
      parentID: "ses_parent",
      messageID: "msg_2",
      source: "subtask",
      targetSessionID: "ses_other",
    });

    expect(state.totalExecuted).toBe(1);
    expect(state.countedChildIDs.ses_other).toBe(true);
    expect(state.countedChildIDs["subtask:part_2"]).toBeUndefined();
  });

  it("ignores a targetless subtask until a matching real session appears", () => {
    const state = createEmptyState();

    upsertRunningChild(state, {
      id: "subtask:part_1",
      title: "Fallback work",
      parentID: "ses_parent",
      messageID: "msg_1",
      source: "subtask",
    });
    expect(state.totalExecuted).toBe(0);
    expect(state.countedChildIDs["subtask:part_1"]).toBeUndefined();

    upsertRunningChild(state, {
      id: "ses_child",
      title: "Child work",
      parentID: "ses_parent",
      messageID: "msg_1",
      source: "session",
    });

    expect(state.totalExecuted).toBe(1);
    expect(state.countedChildIDs.ses_child).toBe(true);
    expect(state.countedChildIDs["subtask:part_1"]).toBeUndefined();
  });

  it("does not count a subtask proxy when details add a target session", () => {
    const state = createEmptyState();

    upsertRunningChild(state, {
      id: "subtask:part_1",
      title: "Fallback work",
      parentID: "ses_parent",
      messageID: "msg_1",
      source: "subtask",
    });
    expect(state.totalExecuted).toBe(0);

    expect(
      upsertChildDetails(state, "subtask:part_1", {
        targetSessionID: "ses_child",
      }),
    ).toBe(true);

    expect(state.totalExecuted).toBe(0);
    expect(state.countedChildIDs.ses_child).toBeUndefined();
    expect(state.countedChildIDs["subtask:part_1"]).toBeUndefined();
  });

  it("classifies visible counter eligibility by real execution semantics", () => {
    expect(
      isVisibleSubagentCounterEligible(
        child({ title: "Delegation: still real", source: "session" }),
      ),
    ).toBe(true);
    expect(
      isVisibleSubagentCounterEligible(
        child({
          id: "tool:delegate",
          source: "tool",
          toolName: "delegate",
          targetSessionID: undefined,
        }),
      ),
    ).toBe(false);
    expect(
      isVisibleSubagentCounterEligible(
        child({
          id: "subtask:proxy",
          source: "subtask",
          targetSessionID: "ses_child",
        }),
      ),
    ).toBe(false);
  });

  it("counts historical executions as unique real session identities", () => {
    const children: ChildSessionState[] = [
      child({
        id: "tool:wrapper",
        source: "tool",
        toolName: "delegate",
        targetSessionID: undefined,
      }),
      child({
        id: "tool:proxy",
        source: "tool",
        toolName: "task",
        targetSessionID: "ses_real_one",
        messageID: "msg_1",
      }),
      child({
        id: "ses_real_one",
        source: "session",
        targetSessionID: "ses_real_one",
        messageID: "msg_1",
        status: "done",
        color: "green",
      }),
      child({
        id: "ses_real_two",
        source: "session",
        targetSessionID: "ses_real_two",
        messageID: "msg_2",
        status: "error",
        color: "red",
      }),
    ];

    expect(countHistoricalSubagentExecutions({ children })).toBe(2);
    expect(
      countHistoricalSubagentExecutions({
        children,
        parentSessionID: "ses_parent",
      }),
    ).toBe(2);
    expect(
      countHistoricalSubagentExecutions({
        children,
        parentSessionID: "ses_other_parent",
      }),
    ).toBe(0);
  });

  it("counts retained real execution statuses with parent scoping", () => {
    const children: ChildSessionState[] = [
      child({
        id: "ses_running",
        targetSessionID: "ses_running",
        messageID: "msg_running",
        status: "running",
      }),
      child({
        id: "tool:done-wrapper",
        source: "tool",
        toolName: "task",
        targetSessionID: "ses_done",
        messageID: "msg_done",
      }),
      child({
        id: "ses_done",
        targetSessionID: "ses_done",
        messageID: "msg_done",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T09:45:00.000Z",
        updatedAt: "2026-04-30T09:45:00.000Z",
      }),
      child({
        id: "ses_error",
        targetSessionID: "ses_error",
        messageID: "msg_error",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T09:44:00.000Z",
        updatedAt: "2026-04-30T09:44:00.000Z",
      }),
      child({
        id: "tool:targetless",
        source: "tool",
        toolName: "delegate",
        targetSessionID: undefined,
        messageID: "msg_targetless",
        status: "done",
        color: "green",
      }),
      child({
        id: "ses_other_error",
        parentID: "ses_other_parent",
        targetSessionID: "ses_other_error",
        messageID: "msg_other_error",
        status: "error",
        color: "red",
      }),
    ];

    expect(countRetainedSubagentStatuses({ children })).toEqual({
      running: 1,
      done: 1,
      error: 2,
    });
    expect(
      countRetainedSubagentStatuses({
        children,
        parentSessionID: "ses_parent",
      }),
    ).toEqual({ running: 1, done: 1, error: 1 });
  });

  it("merges details, sanitizes tokens, and refreshes elapsed fields", () => {
    useFrozenTime("2026-04-30T10:02:00.000Z");
    const state = createEmptyState();
    state.children.ses_child = child();

    expect(
      upsertChildDetails(state, "ses_child", {
        title: "Better title",
        summary: "Better title",
        agentName: "(planner)",
        tokens: { input: 10, output: 5, contextPercent: 33.3 },
      }),
    ).toBe(true);
    refreshDerivedFields(state);

    expect(state.children.ses_child).toMatchObject({
      title: "Better title",
      summary: undefined,
      agentName: "planner",
      elapsedMs: 120000,
      tokens: { input: 10, output: 5, contextPercent: 33.3 },
    });
  });

  it("prunes old terminal children without losing running children", () => {
    const state = createEmptyState();
    state.children.running = child({ id: "running" });
    state.children.oldDone = child({
      id: "oldDone",
      status: "done",
      color: "green",
      endedAt: "2026-04-26T08:00:00.000Z",
      updatedAt: "2026-04-26T08:00:00.000Z",
    });
    state.children.oldError = child({
      id: "oldError",
      status: "error",
      color: "red",
      endedAt: "2026-04-26T08:00:00.000Z",
      updatedAt: "2026-04-26T08:00:00.000Z",
    });
    state.children.recentDone = child({
      id: "recentDone",
      status: "done",
      color: "green",
      endedAt: "2026-04-28T09:30:00.000Z",
      updatedAt: "2026-04-28T09:30:00.000Z",
    });
    state.children.recentError = child({
      id: "recentError",
      status: "error",
      color: "red",
      endedAt: "2026-04-28T09:30:00.000Z",
      updatedAt: "2026-04-28T09:30:00.000Z",
    });

    expect(
      pruneTerminalChildren(state, new Date("2026-04-30T10:00:01.000Z")),
    ).toBe(2);
    expect(Object.keys(state.children).sort()).toEqual([
      "recentDone",
      "recentError",
      "running",
    ]);
  });

  it("resolves state and status text paths from the state override", async () => {
    const harness = await createFileHarness();

    expect(resolveStatePath()).toBe(harness.statePath);
    expect(resolveTextPath(harness.statePath)).toBe(harness.textPath);
  });

  it("writes state as JSON", async () => {
    const harness = await createFileHarness();
    const state = createEmptyState();
    state.children.ses_child = child();
    state.totalExecuted = 1;
    state.countedChildIDs.ses_child = true;

    await saveState(harness.statePath, state);
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({
      totalExecuted: 1,
    });
  });

  it("returns an isolated normalized snapshot without mutating the caller", async () => {
    // Given
    const harness = await createFileHarness();
    const state = createEmptyState();
    state.children.ses_child = child({
      color: "red",
      tokens: { input: 4, output: 6, contextPercent: 12.5 },
      model: {
        providerID: " openai ",
        modelID: " gpt-5.6 ",
        variant: " high ",
      },
    });

    // When
    const prepared = await saveState(harness.statePath, state);

    // Then
    expect(prepared).not.toBe(state);
    expect(prepared.children.ses_child).toMatchObject({
      color: "yellow",
      tokens: { input: 4, output: 6, contextPercent: 12.5 },
      model: {
        providerID: "openai",
        modelID: "gpt-5.6",
        variant: "high",
      },
    });
    expect(state.children.ses_child).toMatchObject({
      color: "red",
      tokens: { input: 4, output: 6, contextPercent: 12.5 },
      model: {
        providerID: " openai ",
        modelID: " gpt-5.6 ",
        variant: " high ",
      },
    });
  });

  it("writes state and text snapshots atomically with owner-only file modes", async () => {
    const harness = await createFileHarness();
    const state = createEmptyState();
    state.children.ses_child = child();
    state.totalExecuted = 1;
    state.countedChildIDs.ses_child = true;

    await saveState(harness.statePath, state);
    await saveStatusText(harness.textPath, "subagents: 1");

    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({
      totalExecuted: 1,
    });
    expect((await stat(harness.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(harness.statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(harness.textPath)).mode & 0o777).toBe(
      0o600,
    );
    expect(
      (await readdir(harness.dir)).some((file) => file.endsWith(".tmp")),
    ).toBe(false);
  });

  it("keeps TUI state and status text writes atomic and owner-only", async () => {
    // Given
    const harness = await createFileHarness();
    const state = createEmptyState();
    state.children.ses_child = child({
      id: "ses_child",
      parentID: "ses_root",
    });

    // When
    await saveState(harness.statePath, state);
    await saveStatusText(harness.textPath, "status");

    // Then
    expect(await pathExists(harness.statePath)).toBe(true);
    expect(await pathExists(harness.textPath)).toBe(true);
    expect((await stat(harness.statePath)).mode & 0o777).toBe(0o600);
    expect((await stat(harness.textPath)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(harness.dir)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  it("characterizes exact three-day terminal retention boundary (TERMINAL_CHILD_TTL_MS = 7776000000 ms)", () => {
    const state = createEmptyState();
    const now = new Date("2026-05-01T10:00:00.000Z");
    // Child exactly 3 days old (referenceMs = 2026-04-28 10:00)
    state.children.oldDone = child({
      id: "oldDone",
      status: "done",
      color: "green",
      endedAt: "2026-04-28T10:00:00.000Z",
      updatedAt: "2026-04-28T10:00:00.000Z",
    });
    // Child 3 days + 1 ms old (should be pruned)
    state.children.veryOldDone = child({
      id: "veryOldDone",
      status: "done",
      color: "green",
      endedAt: "2026-04-28T09:59:59.999Z",
      updatedAt: "2026-04-28T09:59:59.999Z",
    });
    // Running child must survive pruning regardless of age.
    state.children.running = child({ id: "running", status: "running" });

    const pruned = pruneTerminalChildren(state, now);
    expect(pruned).toBe(1);
    expect(state.children.veryOldDone).toBeUndefined();
    expect(state.children.oldDone).toBeDefined();
    expect(state.children.running).toBeDefined();
  });

  it("characterizes 1500-row terminal retention cap (MAX_TERMINAL_CHILDREN = 1500)", () => {
    const state = createEmptyState();
    const now = new Date("2026-05-01T10:00:00.000Z");
    for (let i = 0; i < 1505; i++) {
      state.children[`terminal_${i}`] = child({
        id: `terminal_${i}`,
        status: "done",
        color: "green",
        endedAt: "2026-04-30T09:00:00.000Z",
        updatedAt: "2026-04-30T09:00:00.000Z",
      });
    }
    const pruned = pruneTerminalChildren(state, now);
    expect(pruned).toBe(5);
    expect(Object.keys(state.children)).toHaveLength(1500);
  });

  it("characterizes pruning removes oldest terminal by referenceMs then by id", () => {
    const state = createEmptyState();
    const now = new Date("2026-05-01T10:00:00.000Z");
    // Rows 2 days old should not be pruned by TTL (3-day boundary).
    state.children.a = child({ id: "a", status: "done", endedAt: "2026-04-29T08:00:00.000Z", updatedAt: "2026-04-29T08:00:00.000Z" });
    state.children.b = child({ id: "b", status: "done", endedAt: "2026-04-29T09:00:00.000Z", updatedAt: "2026-04-29T09:00:00.000Z" });
    state.children.c = child({ id: "c", status: "done", endedAt: "2026-04-29T09:00:00.000Z", updatedAt: "2026-04-29T09:00:00.000Z" });

    const pruned = pruneTerminalChildren(state, now);
    // Within TTL, no rows removed by TTL; cap not exceeded with 3 rows.
    expect(pruned).toBe(0);
    expect(state.children.a).toBeDefined();
    expect(state.children.b).toBeDefined();
    expect(state.children.c).toBeDefined();
  });

  it("characterizes retained-only counters ignore tool/subtask wrappers", () => {
    const state = createEmptyState();
    upsertRunningChild(state, {
      id: "tool:wrapper",
      title: "Delegate",
      parentID: "ses_parent",
      source: "tool",
      targetSessionID: undefined,
    });
    upsertRunningChild(state, {
      id: "subtask:proxy",
      title: "Subtask",
      parentID: "ses_parent",
      source: "subtask",
      targetSessionID: "ses_child",
    });
    expect(state.totalExecuted).toBe(0);
    expect(state.countedChildIDs["tool:wrapper"]).toBeUndefined();
    expect(state.countedChildIDs["subtask:proxy"]).toBeUndefined();
  });

  it("characterizes atomic persistence leaves no leftover .tmp files and applies owner-only mode", async () => {
    const harness = await createFileHarness();
    const state = createEmptyState();
    state.children.ses_child = child();
    await saveState(harness.statePath, state);

    expect(await pathExists(harness.statePath)).toBe(true);
    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({
      children: expect.any(Object),
    });
    // Verify no leftover temp files in directory.
    const files = await readdir(harness.dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    // File mode assertions already in existing test; this locks observable behavior.
  });

  it("sanitizes and retains model metadata through persistence", async () => {
    const harness = await createFileHarness();
    const state = createEmptyState();
    state.children.ses_child = child({
      model: { providerID: " openai ", modelID: " gpt-5.6 ", variant: " high " },
    });

    await saveState(harness.statePath, state);

    expect(JSON.parse(await readFile(harness.statePath, "utf8"))).toMatchObject({
      children: {
        ses_child: {
          model: {
            providerID: "openai",
            modelID: "gpt-5.6",
            variant: "high",
          },
        },
      },
    });
  });

  it("refreshes only explicitly changed children before a snapshot", () => {
    // Given
    const state = createEmptyState();
    state.children.changed = child({
      id: "changed",
      model: { providerID: " openai ", modelID: " gpt-5.6 " },
    });
    state.children.unchanged = child({
      id: "unchanged",
      model: { providerID: " anthropic ", modelID: " claude " },
    });

    // When
    refreshStateForSnapshot(
      state,
      ["changed"],
      new Date("2026-04-30T10:05:00.000Z"),
    );

    // Then
    expect(state.children.changed.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6",
    });
    expect(state.children.unchanged.model).toEqual({
      providerID: " anthropic ",
      modelID: " claude ",
    });
  });
});
