import { describe, expect, it } from "vitest";
import {
  buildSubagentProjection,
  buildSubagentProjectionFromChildren,
  filterVisibleFromCanonical,
  type SubagentProjection,
} from "./projection.js";
import { correlateSubagentWorkItems } from "./subagent-classification.js";
import type { ChildSessionState, StatuslineState } from "./state.js";

function child(overrides: Partial<ChildSessionState> = {}): ChildSessionState {
  return {
    id: "ses_child",
    title: "Child work",
    parentID: "ses_parent",
    messageID: "msg_1",
    source: "session",
    targetSessionID: "ses_child",
    status: "running",
    color: "yellow",
    startedAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:01:00.000Z",
    elapsedMs: 61000,
    ...overrides,
  };
}

describe("subagent projection", () => {
  it("produces canonical rows from correlation with merged proxy metadata", () => {
    const state: StatuslineState = {
      children: {
        "tool:proxy": {
          ...child({
            id: "tool:proxy",
            source: "tool",
            title: "Proxy title",
            targetSessionID: "ses_real",
            status: "running",
            color: "yellow",
            messageID: "msg_1",
          }),
        },
        "ses_real": {
          ...child({
            id: "ses_real",
            title: "Real title",
            targetSessionID: "ses_real",
            status: "done",
            color: "green",
            endedAt: "2026-04-30T10:05:00.000Z",
          }),
        },
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    const projection = buildSubagentProjection(state);

    expect(projection.canonicalRows).toHaveLength(1);
    expect(projection.canonicalRows[0].id).toBe("ses_real");
    expect(projection.canonicalRows[0].title).toBe("Proxy title");
    expect(projection.canonicalRows[0].status).toBe("done");
    expect(projection.canonicalRows[0].color).toBe("green");
  });

  it("computes retained counts from canonical real executions only", () => {
    const state: StatuslineState = {
      children: {
        running: child({ id: "running", targetSessionID: "running", status: "running" }),
        done: child({ id: "done", targetSessionID: "done", status: "done", color: "green" }),
        error: child({ id: "error", targetSessionID: "error", status: "error", color: "red" }),
        wrapper: child({
          id: "wrapper",
          source: "tool",
          targetSessionID: undefined,
        }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    const projection = buildSubagentProjection(state);

    expect(projection.retainedCounts).toEqual({
      running: 1,
      done: 1,
      error: 1,
    });
  });

  it("computes total executed as unique real execution IDs, excluding wrappers", () => {
    const state: StatuslineState = {
      children: {
        "ses_first": child({ id: "ses_first", targetSessionID: "ses_first" }),
        "tool:proxy": child({
          id: "tool:proxy",
          source: "tool",
          targetSessionID: "ses_first",
        }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    const projection = buildSubagentProjection(state);
    expect(projection.totalExecuted).toBe(1);
    expect(projection.orderedExecutionIDs).toEqual(["ses_first"]);
  });

  it("provides stable ordered execution IDs and lookup maps", () => {
    const state: StatuslineState = {
      children: {
        "ses_b": child({ id: "ses_b", targetSessionID: "ses_b" }),
        "ses_a": child({ id: "ses_a", targetSessionID: "ses_a" }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    const projection = buildSubagentProjection(state);
    expect(projection.orderedExecutionIDs).toEqual(["ses_b", "ses_a"]);
    expect(projection.rowByExecutionID.get("ses_b")?.id).toBe("ses_b");
    expect(projection.rowByExecutionID.get("ses_a")?.id).toBe("ses_a");
  });

  it("excludes invocation wrappers from canonical rows and counts", () => {
    const state: StatuslineState = {
      children: {
        "tool:delegate": child({
          id: "tool:delegate",
          source: "tool",
          toolName: "delegate",
          targetSessionID: undefined,
        }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    const projection = buildSubagentProjection(state);
    expect(projection.canonicalRows).toHaveLength(0);
    expect(projection.retainedCounts).toEqual({
      running: 0,
      done: 0,
      error: 0,
    });
    expect(projection.totalExecuted).toBe(0);
    expect(projection.orderedExecutionIDs).toHaveLength(0);
  });

  it("preserves first-real insertion order for duplicate execution IDs", () => {
    const state: StatuslineState = {
      children: {
        first: child({ id: "ses_dup", title: "First", targetSessionID: "ses_dup" }),
        second: child({ id: "ses_dup", title: "Second", targetSessionID: "ses_dup" }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    const projection = buildSubagentProjection(state);
    expect(projection.canonicalRows).toHaveLength(1);
    expect(projection.canonicalRows[0].title).toBe("First");
    expect(projection.totalExecuted).toBe(1);
  });

  it("produces row lookup maps for derived consumer use", () => {
    const state: StatuslineState = {
      children: {
        "ses_a": child({ id: "ses_a", targetSessionID: "ses_a" }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    const projection = buildSubagentProjection(state);
    expect(projection.rowByChildID.get("ses_a")?.id).toBe("ses_a");
    expect(projection.rowByExecutionID.get("ses_a")?.id).toBe("ses_a");
  });

  it("preserves real/proxy semantics: wrapper exclusion, retained-only total, stable order", () => {
    const state: StatuslineState = {
      children: {
        real: child({ id: "ses_real", targetSessionID: "ses_real", status: "done", color: "green" }),
        proxy: child({ id: "tool:p", source: "tool", targetSessionID: "ses_real", title: "P" }),
        wrapper: child({ id: "subtask:w", source: "subtask", targetSessionID: undefined }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    const projection = buildSubagentProjection(state);
    expect(projection.canonicalRows).toHaveLength(1);
    expect(projection.canonicalRows[0].id).toBe("ses_real");
    expect(projection.retainedCounts).toEqual({ running: 0, done: 1, error: 0 });
    expect(projection.totalExecuted).toBe(1);
    expect(projection.orderedExecutionIDs).toEqual(["ses_real"]);
  });

  it("projection-aware filter does not rebuild correlation (seam assertion)", () => {
    // Build projection once; filter from canonical rows directly.
    const state: StatuslineState = {
      children: {
        "ses_a": child({ id: "ses_a", targetSessionID: "ses_a", status: "running" }),
        "ses_done": child({ id: "ses_done", targetSessionID: "ses_done", status: "done", color: "green" }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };
    const projection = buildSubagentProjection(state);
    // filterVisibleFromCanonical operates directly on canonicalRows,
    // without invoking buildSubagentProjectionFromChildren again.
    const visible = filterVisibleFromCanonical(projection.canonicalRows);
    expect(visible.map((v) => v.id)).toEqual(["ses_a"]);
    expect(visible.length).toBe(1);
    // The projection's canonical rows must already contain merged metadata.
    expect(projection.canonicalRows[0].id).toBe("ses_a");
  });

  it("projection-aware filter does not rebuild correlation (seam assertion)", () => {
    // Build projection once; filter from canonical rows directly.
    // The projection's canonical rows are already collapsed and merged,
    // so filterVisibleFromCanonical operates directly without re-correlation.
    const state: StatuslineState = {
      children: {
        "ses_a": child({ id: "ses_a", targetSessionID: "ses_a", status: "running" }),
        "ses_done": child({ id: "ses_done", targetSessionID: "ses_done", status: "done", color: "green" }),
      },
      countedChildIDs: {},
      totalExecuted: 0,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };
    const projection = buildSubagentProjection(state);
    const visible = filterVisibleFromCanonical(projection.canonicalRows);
    expect(visible.map((v) => v.id)).toEqual(["ses_a"]);
    expect(visible.length).toBe(1);
    // The projection's canonical rows must already contain merged metadata.
    expect(projection.canonicalRows[0].id).toBe("ses_a");
  });

  it("scoped snapshot excludes out-of-scope proxy children before correlation", () => {
    // Old behavior: filter raw children by parent session BEFORE correlation.
    // A proxy with parent B targeting real A must not override A's metadata
    // when viewing parent B's scope (because A has different parent).
    const state: StatuslineState = {
      children: {
        // Real session with parent A
        "ses_real": child({ id: "ses_real", parentID: "ses_A", targetSessionID: "ses_real", title: "Real A", status: "done", color: "green" }),
        // Proxy with parent B targeting A's session
        "tool:proxy_b": child({ id: "tool:proxy_b", parentID: "ses_B", source: "tool", targetSessionID: "ses_real", title: "Proxy B" }),
      },
      countedChildIDs: { ses_real: true },
      totalExecuted: 1,
      updatedAt: "2026-04-30T10:00:00.000Z",
    };

    // When scoped to parent A, only real A should appear.
    const projectionA = buildSubagentProjectionFromChildren(
      Object.values(state.children).filter((c) => c.parentID === "ses_A"),
    );
    expect(projectionA.canonicalRows).toHaveLength(1);
    expect(projectionA.canonicalRows[0].id).toBe("ses_real");
    expect(projectionA.canonicalRows[0].title).toBe("Real A");
    expect(projectionA.retainedCounts).toEqual({ running: 0, done: 1, error: 0 });

    // When scoped to parent B, proxy should be excluded (no real session for B),
    // so no rows and zero counts.
    const projectionB = buildSubagentProjectionFromChildren(
      Object.values(state.children).filter((c) => c.parentID === "ses_B"),
    );
    expect(projectionB.canonicalRows).toHaveLength(0);
    expect(projectionB.retainedCounts).toEqual({ running: 0, done: 0, error: 0 });
  });
});
