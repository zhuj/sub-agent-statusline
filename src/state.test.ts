import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  countHistoricalSubagentExecutions,
  countRetainedSubagentStatuses,
  getCounts,
  isVisibleSubagentCounterEligible,
  markChildStatus,
  markChildrenStatusByAnyID,
  pruneTerminalChildren,
  refreshDerivedFields,
  setChildModel,
  upsertChildDetails,
  upsertRunningChild,
  type ChildSessionState,
} from "./state.js";
import { useFrozenTime } from "../test/helpers/runtime-harness.js";

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
  it("counts new executions without scanning previously counted identities", () => {
    const state = createEmptyState();
    state.totalExecuted = 1;
    Object.defineProperty(state.countedChildIDs, "ses_previous", {
      enumerable: true,
      get() { throw new Error("unrelated execution identity was read"); },
    });
    const input = { id: "ses_new", parentID: "ses_root", title: "New child" };
    upsertRunningChild(state, input);
    expect(state.totalExecuted).toBe(2);
    expect(state.countedChildIDs.ses_new).toBe(true);
    upsertRunningChild(state, input);
    expect(state.totalExecuted).toBe(2);
  });

  it("completes indexed aliases without scanning unrelated rows", () => {
    const state = createEmptyState();
    state.children.ses_real = child({ id: "ses_real", targetSessionID: "ses_real" });
    state.children.alias = child({ id: "alias", targetSessionID: "ses_real" });
    Object.defineProperty(state.children, "unrelated", {
      enumerable: true,
      get() { throw new Error("unrelated row read"); },
    });
    expect(markChildStatus(state, "ses_real", "done", undefined,
      ["ses_real", "alias", "missing"])).toBe(true);
    expect(state.children.ses_real?.status).toBe("done");
    expect(state.children.alias?.status).toBe("done");
  });

  it("updates indexed session aliases without reading unrelated rows", () => {
    const state = createEmptyState();
    state.children.ses_real = child({ id: "ses_real", targetSessionID: "ses_real" });
    state.children.alias = child({ id: "alias", targetSessionID: "ses_real" });
    Object.defineProperty(state.children, "unrelated", {
      enumerable: true,
      get() { throw new Error("unrelated row read"); },
    });
    const model = { providerID: "openai", modelID: "test-model" };
    expect(setChildModel(state, "ses_real", model, undefined,
      ["ses_real", "alias", "missing"])).toBe(true);
    expect(state.children.ses_real?.model).toEqual(model);
    expect(state.children.alias?.model).toEqual(model);
  });

  it("preserves old ancestors until their active leaf completes", () => {
    const state = createEmptyState();
    for (const item of [
      child({ id: "ses_parent", parentID: "ses_root", status: "done" }),
      child({ id: "ses_middle", parentID: "ses_parent", status: "done" }),
      child({ id: "ses_leaf", parentID: "ses_middle", status: "running" }),
      child({ id: "ses_old", parentID: "ses_root", status: "done" }),
    ]) state.children[item.id] = item;

    const now = new Date("2030-01-01T00:00:00Z");
    expect(pruneTerminalChildren(state, now)).toBe(1);
    expect(Object.keys(state.children).sort()).toEqual([
      "ses_leaf", "ses_middle", "ses_parent",
    ]);
    state.children.ses_leaf = child({
      id: "ses_leaf", parentID: "ses_middle", status: "done",
    });
    expect(pruneTerminalChildren(state, now)).toBe(3);
    expect(Object.keys(state.children)).toEqual([]);
  });

  it("preserves active ancestors beyond the terminal retention cap", () => {
    const state = createEmptyState();
    const recent = "2026-04-30T10:00:00.000Z";
    const olderRecent = "2026-04-29T10:00:00.000Z";
    for (const item of [
      child({ id: "ses_root", parentID: "ses_missing", status: "done", endedAt: recent }),
      child({ id: "ses_parent", parentID: "ses_root", status: "done", endedAt: recent }),
      child({ id: "ses_leaf", parentID: "ses_parent", status: "running" }),
    ]) state.children[item.id] = item;
    for (let index = 0; index < 1_500; index += 1) {
      const id = `ses_unrelated_${String(index).padStart(4, "0")}`;
      state.children[id] = child({ id, parentID: "ses_other", status: "done", endedAt: recent });
    }
    state.children.ses_unrelated_excess = child({
      id: "ses_unrelated_excess", parentID: "ses_other", status: "done", endedAt: olderRecent,
    });
    expect(pruneTerminalChildren(state, new Date("2026-04-30T10:00:01.000Z"))).toBe(1);
    expect(state.children.ses_root).toBeDefined();
    expect(state.children.ses_parent).toBeDefined();
    expect(state.children.ses_leaf).toBeDefined();
    expect(state.children.ses_unrelated_excess).toBeUndefined();
    expect(Object.keys(state.children).filter((id) => id.startsWith("ses_unrelated_"))).toHaveLength(1_500);
  });

  it("terminates on cyclic ancestry while preserving reachable ancestors", () => {
    const state = createEmptyState();
    const old = "2026-04-26T08:00:00.000Z";
    for (const item of [
      child({ id: "ses_parent", parentID: "ses_middle", status: "done", endedAt: old }),
      child({ id: "ses_middle", parentID: "ses_parent", status: "done", endedAt: old }),
      child({ id: "ses_leaf", parentID: "ses_middle", status: "running" }),
      child({ id: "ses_unrelated", parentID: "ses_other", status: "done", endedAt: old }),
    ]) state.children[item.id] = item;
    expect(pruneTerminalChildren(state, new Date("2026-04-30T10:00:01.000Z"))).toBe(1);
    expect(Object.keys(state.children).sort()).toEqual(["ses_leaf", "ses_middle", "ses_parent"]);
  });

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

  it("retains normalized rows and replaces only rows with derived changes", () => {
    const state = createEmptyState();
    const unchanged = child({
      id: "ses_unchanged",
      targetSessionID: "ses_unchanged",
      status: "done",
      color: "green",
      updatedAt: "2026-04-30T10:01:00.000Z",
      endedAt: "2026-04-30T10:01:00.000Z",
      elapsedMs: 60_000,
      tokens: { total: 1 },
    });
    const changed = child({
      id: "ses_changed",
      targetSessionID: "ses_changed",
      color: "red",
      elapsedMs: 0,
    });
    state.children = { ses_unchanged: unchanged, ses_changed: changed };

    refreshDerivedFields(state, new Date("2026-04-30T10:05:00.000Z"));

    expect(state.children.ses_unchanged).toBe(unchanged);
    expect(state.children.ses_changed).not.toBe(changed);
    expect(state.children.ses_changed).toMatchObject({
      color: "yellow",
      elapsedMs: 300_000,
    });
    expect(changed).toMatchObject({ color: "red", elapsedMs: 0 });
  });

  it("reuses normalized rows and replaces only changed derived rows", () => {
    const state = createEmptyState();
    const unchanged = child({
      id: "ses_unchanged",
      targetSessionID: "ses_unchanged",
      status: "done",
      color: "green",
      updatedAt: "2026-04-30T10:01:00.000Z",
      endedAt: "2026-04-30T10:01:00.000Z",
      elapsedMs: 60_000,
      tokens: { total: 1 },
    });
    const changed = child({
      id: "ses_changed",
      targetSessionID: "ses_changed",
      color: "red",
      elapsedMs: 0,
    });
    state.children = { ses_unchanged: unchanged, ses_changed: changed };

    refreshDerivedFields(state, new Date("2026-04-30T10:05:00.000Z"));

    expect(state.children.ses_unchanged).toBe(unchanged);
    expect(state.children.ses_changed).not.toBe(changed);
    expect(state.children.ses_changed).toMatchObject({
      color: "yellow",
      elapsedMs: 300_000,
    });
    expect(changed).toMatchObject({ color: "red", elapsedMs: 0 });
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

  it("marks every id and target alias at one completion instant", () => {
    useFrozenTime("2026-04-30T10:05:00.000Z");
    const state = createEmptyState();
    state.children["ses_child"] = child({
      id: "ses_child",
      targetSessionID: "ses_child",
    });
    state.children["tool:one"] = child({
      id: "tool:one",
      source: "tool",
      targetSessionID: "ses_child",
    });
    state.children["subtask:one"] = child({
      id: "subtask:one",
      source: "subtask",
      targetSessionID: "ses_child",
    });
    state.children["ses_other"] = child({
      id: "ses_other",
      targetSessionID: "ses_other",
    });
    const otherRef = state.children["ses_other"];

    expect(
      markChildrenStatusByAnyID(state, {
        childIDs: new Set(["ses_child"]),
        status: "done",
      }),
    ).toBe(true);

    const frozenInstant = "2026-04-30T10:05:00.000Z";
    for (const childID of ["ses_child", "tool:one", "subtask:one"]) {
      expect(state.children[childID]).toMatchObject({
        status: "done",
        color: "green",
        updatedAt: frozenInstant,
        endedAt: frozenInstant,
        elapsedMs: 300000,
      });
    }
    expect(state.updatedAt).toBe(frozenInstant);
    expect(state.children["ses_other"]).toBe(otherRef);
    expect(state.children["ses_other"]).toMatchObject({
      status: "running",
      color: "yellow",
      targetSessionID: "ses_other",
      updatedAt: "2026-04-30T10:00:00.000Z",
    });
  });
});
