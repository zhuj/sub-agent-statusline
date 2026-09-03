import { describe, expect, it } from "vitest";
import {
  buildSubagentProjection,
  buildSubagentProjectionFromChildren,
  filterVisibleFromCanonical,
  getSubagentLineageIndex,
  projectSubagentSubtree,
} from "./projection.js";
import { byPriority } from "./render.js";
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

const stateWithProjectionRows = (
  rows: readonly ChildSessionState[],
): StatuslineState => ({
  children: Object.fromEntries(rows.map((row) => [row.id, row])),
  countedChildIDs: Object.fromEntries(
    rows.map((row) => [row.id, true as const]),
  ),
  totalExecuted: rows.length,
  updatedAt: "2026-09-02T00:00:00.000Z",
});

describe("subagent projection", () => {
  it("projects every depth parent-first while preserving sibling priority", () => {
    // Given
    const state = stateWithProjectionRows([
      child({
        id: "ses_a_old",
        parentID: "ses_root",
        targetSessionID: "ses_a_old",
        startedAt: "2026-01-01T00:00:00Z",
      }),
      child({
        id: "ses_a_new",
        parentID: "ses_root",
        targetSessionID: "ses_a_new",
        startedAt: "2026-01-02T00:00:00Z",
      }),
      child({
        id: "ses_grand",
        parentID: "ses_a_new",
        targetSessionID: "ses_grand",
      }),
      child({
        id: "ses_deep",
        parentID: "ses_grand",
        targetSessionID: "ses_deep",
      }),
      child({
        id: "ses_other",
        parentID: "ses_unrelated",
        targetSessionID: "ses_other",
      }),
    ]);

    // When
    const result = projectSubagentSubtree({
      index: getSubagentLineageIndex(state),
      rootSessionID: "ses_root",
      compareSiblings: byPriority,
    });

    // Then
    expect(result.rows.map(({ child: row, depth }) => [row.id, depth])).toEqual([
      ["ses_a_new", 0],
      ["ses_grand", 1],
      ["ses_deep", 2],
      ["ses_a_old", 0],
    ]);
  });

  it("uses only real parent links for ancestry while retaining synthetic correlation", () => {
    // Given
    const state = stateWithProjectionRows([
      child({
        id: "ses_real",
        parentID: "ses_root",
        targetSessionID: "ses_real",
      }),
      child({
        id: "tool:proxy",
        source: "tool",
        parentID: "ses_root",
        targetSessionID: "ses_real",
        title: "Proxy title",
      }),
      child({
        id: "tool:heuristic-parent",
        source: "tool",
        parentID: "ses_root",
        targetSessionID: "ses_hidden",
      }),
      child({
        id: "ses_false_descendant",
        parentID: "tool:heuristic-parent",
        targetSessionID: "ses_false_descendant",
      }),
    ]);

    // When
    const result = projectSubagentSubtree({
      index: getSubagentLineageIndex(state),
      rootSessionID: "ses_root",
      compareSiblings: byPriority,
    });

    // Then
    expect(result.rows.map(({ child: row }) => row.id)).toEqual(["ses_real"]);
    expect(result.rows[0]?.child.title).toBe("Proxy title");
    expect(result.executionIDs).toEqual(new Set(["ses_real"]));
    expect(result.retainedCounts).toEqual({ running: 1, done: 0, error: 0 });
  });

  it("does not treat a real execution target as an ancestry edge", () => {
    // Given
    const state = stateWithProjectionRows([
      child({
        id: "ses_raw",
        parentID: "ses_root",
        targetSessionID: "ses_execution",
      }),
      child({
        id: "ses_false_descendant",
        parentID: "ses_execution",
        targetSessionID: "ses_false_descendant",
      }),
    ]);

    // When
    const result = projectSubagentSubtree({
      index: getSubagentLineageIndex(state),
      rootSessionID: "ses_root",
      compareSiblings: byPriority,
    });

    // Then
    expect(result.rows.map(({ child: row }) => row.id)).toEqual(["ses_raw"]);
    expect(result.canonicalRows.map(({ id }) => id)).toEqual(["ses_raw"]);
    expect(result.executionIDs).toEqual(new Set(["ses_execution"]));
    expect(result.retainedCounts).toEqual({ running: 1, done: 0, error: 0 });
  });

  it("ignores malformed targets when choosing canonical emitted identities", () => {
    // Given
    const first = child({
      id: "ses_first",
      parentID: "ses_root",
      targetSessionID: "malformed-target",
    });
    const second = child({
      id: "ses_second",
      parentID: "ses_root",
      targetSessionID: "malformed-target",
    });
    const state: StatuslineState = {
      ...stateWithProjectionRows([]),
      children: { first, second },
    };

    // When
    const result = projectSubagentSubtree({
      index: getSubagentLineageIndex(state),
      rootSessionID: "ses_root",
      compareSiblings: byPriority,
    });

    // Then
    expect(result.rows.map(({ child: row }) => row.id)).toEqual([
      "ses_first",
      "ses_second",
    ]);
    expect(result.executionIDs).toEqual(new Set(["ses_first", "ses_second"]));
  });

  it("preserves many nested descendants under deduplicated aliases", () => {
    // Given
    const aliasNames = ["a", "b", "c", "d", "e", "f"] as const;
    const aliases = aliasNames.map((suffix, index) => ({
      suffix,
      row: child({
        id: `ses_alias_${suffix}`,
        parentID: "ses_root",
        targetSessionID: "ses_execution",
        startedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    }));
    const descendants = aliases.map(({ suffix, row }, index) => ({
      suffix,
      row: child({
        id: `ses_alias_descendant_${suffix}`,
        parentID: row.id,
        targetSessionID: `ses_alias_descendant_${suffix}`,
        startedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    }));
    const nestedDescendants = descendants.map(({ suffix, row }) => ({
      suffix,
      row: child({
        id: `ses_alias_nested_${suffix}`,
        parentID: row.id,
        targetSessionID: `ses_alias_nested_${suffix}`,
      }),
    }));
    const deepDescendants = nestedDescendants.map(({ suffix, row }) =>
      child({
        id: `ses_alias_deep_${suffix}`,
        parentID: row.id,
        targetSessionID: `ses_alias_deep_${suffix}`,
      }),
    );
    const allRows = [
      ...aliases.map(({ row }) => row),
      ...descendants.map(({ row }) => row),
      ...nestedDescendants.map(({ row }) => row),
      ...deepDescendants,
    ];
    const state: StatuslineState = {
      ...stateWithProjectionRows([]),
      children: Object.fromEntries(
        allRows.map(
          (row): readonly [string, ChildSessionState] => [row.id, row],
        ),
      ),
    };

    // When
    const result = projectSubagentSubtree({
      index: getSubagentLineageIndex(state),
      rootSessionID: "ses_root",
      compareSiblings: () => 0,
    });

    // Then
    expect(
      result.rows.map(({ child: row, depth, parentSessionID }) => [
        row.id,
        depth,
        parentSessionID,
      ]),
    ).toEqual([
      ["ses_alias_a", 0, "ses_root"],
      ["ses_alias_descendant_a", 1, "ses_alias_a"],
      ["ses_alias_nested_a", 2, "ses_alias_descendant_a"],
      ["ses_alias_deep_a", 3, "ses_alias_nested_a"],
      ["ses_alias_descendant_b", 1, "ses_alias_b"],
      ["ses_alias_nested_b", 2, "ses_alias_descendant_b"],
      ["ses_alias_deep_b", 3, "ses_alias_nested_b"],
      ["ses_alias_descendant_c", 1, "ses_alias_c"],
      ["ses_alias_nested_c", 2, "ses_alias_descendant_c"],
      ["ses_alias_deep_c", 3, "ses_alias_nested_c"],
      ["ses_alias_descendant_d", 1, "ses_alias_d"],
      ["ses_alias_nested_d", 2, "ses_alias_descendant_d"],
      ["ses_alias_deep_d", 3, "ses_alias_nested_d"],
      ["ses_alias_descendant_e", 1, "ses_alias_e"],
      ["ses_alias_nested_e", 2, "ses_alias_descendant_e"],
      ["ses_alias_deep_e", 3, "ses_alias_nested_e"],
      ["ses_alias_descendant_f", 1, "ses_alias_f"],
      ["ses_alias_nested_f", 2, "ses_alias_descendant_f"],
      ["ses_alias_deep_f", 3, "ses_alias_nested_f"],
    ]);
    expect(result.executionIDs).toEqual(
      new Set([
        "ses_execution",
        "ses_alias_descendant_a",
        "ses_alias_descendant_b",
        "ses_alias_descendant_c",
        "ses_alias_descendant_d",
        "ses_alias_descendant_e",
        "ses_alias_descendant_f",
        "ses_alias_nested_a",
        "ses_alias_nested_b",
        "ses_alias_nested_c",
        "ses_alias_nested_d",
        "ses_alias_nested_e",
        "ses_alias_nested_f",
        "ses_alias_deep_a",
        "ses_alias_deep_b",
        "ses_alias_deep_c",
        "ses_alias_deep_d",
        "ses_alias_deep_e",
        "ses_alias_deep_f",
      ]),
    );
    expect(result.retainedCounts).toEqual({ running: 19, done: 0, error: 0 });
  });

  it("emits malformed cycles and duplicate execution identities at most once", () => {
    // Given
    const state = stateWithProjectionRows([
      child({ id: "ses_a", parentID: "ses_b", targetSessionID: "ses_a" }),
      child({ id: "ses_b", parentID: "ses_a", targetSessionID: "ses_b" }),
      child({
        id: "ses_duplicate",
        source: undefined,
        parentID: "ses_b",
        targetSessionID: "ses_duplicate",
      }),
      child({
        id: "ses_duplicate_alias",
        source: undefined,
        parentID: "ses_b",
        targetSessionID: "ses_duplicate",
      }),
    ]);

    // When
    const result = projectSubagentSubtree({
      index: getSubagentLineageIndex(state),
      rootSessionID: "ses_a",
      compareSiblings: byPriority,
    });

    // Then
    expect(result.rows.map(({ child: row }) => row.id)).toEqual([
      "ses_b",
      "ses_duplicate",
    ]);
    expect(result.executionIDs.size).toBe(2);
    expect(result.retainedCounts).toEqual({ running: 2, done: 0, error: 0 });
  });

  it("lets only the authoritative row extend ancestry when a proxy shares its id", () => {
    // Given
    const proxy = child({
      id: "shared",
      source: "tool",
      parentID: "ses_root",
      targetSessionID: "ses_shared",
    });
    const real = child({
      id: "shared",
      source: "session",
      parentID: "ses_root",
      targetSessionID: "ses_shared",
    });
    const descendant = child({
      id: "ses_descendant",
      parentID: "shared",
      targetSessionID: "ses_descendant",
    });
    const state: StatuslineState = {
      ...stateWithProjectionRows([]),
      children: { proxy, real, descendant },
    };

    // When
    const result = projectSubagentSubtree({
      index: getSubagentLineageIndex(state),
      rootSessionID: "ses_root",
      compareSiblings: byPriority,
    });

    // Then
    expect(result.rows.map(({ child: row }) => row.id)).toEqual([
      "shared",
      "ses_descendant",
    ]);
  });

  it("reflects additions made to the same state object", () => {
    // Given
    const state = stateWithProjectionRows([
      child({
        id: "ses_a",
        parentID: "ses_root",
        targetSessionID: "ses_a",
      }),
    ]);
    getSubagentLineageIndex(state);

    // When
    state.children["ses_b"] = child({
      id: "ses_b",
      parentID: "ses_root",
      targetSessionID: "ses_b",
    });
    const rebuilt = getSubagentLineageIndex(state);

    // Then
    expect(rebuilt.rowsByParentID.get("ses_root")?.map(({ id }) => id)).toEqual([
      "ses_a",
      "ses_b",
    ]);
  });

  it("reflects deletions made to the same state object", () => {
    // Given
    const state = stateWithProjectionRows([
      child({ id: "ses_a", parentID: "ses_root", targetSessionID: "ses_a" }),
      child({ id: "ses_b", parentID: "ses_root", targetSessionID: "ses_b" }),
    ]);
    getSubagentLineageIndex(state);

    // When
    delete state.children["ses_b"];
    const rebuilt = getSubagentLineageIndex(state);

    // Then
    expect(rebuilt.rowsByParentID.get("ses_root")?.map(({ id }) => id)).toEqual([
      "ses_a",
    ]);
  });

  it("reflects reparenting made to the same state object", () => {
    // Given
    const state = stateWithProjectionRows([
      child({ id: "ses_a", parentID: "ses_root", targetSessionID: "ses_a" }),
    ]);
    getSubagentLineageIndex(state);

    // When
    state.children["ses_a"] = child({
      id: "ses_a",
      parentID: "ses_other",
      targetSessionID: "ses_a",
    });
    const rebuilt = getSubagentLineageIndex(state);

    // Then
    expect(rebuilt.rowsByParentID.get("ses_root")).toBeUndefined();
    expect(rebuilt.rowsByParentID.get("ses_other")?.map(({ id }) => id)).toEqual([
      "ses_a",
    ]);
  });

  it("enumerates state once per fresh 2000-row index and emits unique executions", () => {
    // Given
    let reads = 0;
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      child({
        id: `ses_${index}`,
        parentID: index === 0 ? "ses_root" : `ses_${index - 1}`,
        targetSessionID: `ses_${index}`,
      }),
    );
    const children = Object.fromEntries(rows.map((row) => [row.id, row]));
    const observed = new Proxy(children, {
      ownKeys(target) {
        reads += 1;
        return Reflect.ownKeys(target);
      },
    });
    const state: StatuslineState = {
      ...stateWithProjectionRows([]),
      children: observed,
    };

    // When
    const firstIndex = getSubagentLineageIndex(state);
    const result = projectSubagentSubtree({
      index: firstIndex,
      rootSessionID: "ses_root",
      compareSiblings: byPriority,
    });
    const emittedExecutionIDs = result.rows.map(
      ({ child: row }) => row.targetSessionID ?? row.id,
    );

    // Then
    expect(emittedExecutionIDs).toHaveLength(2_000);
    expect(new Set(emittedExecutionIDs).size).toBe(2_000);
    expect(result.executionIDs).toEqual(new Set(emittedExecutionIDs));
    expect(reads).toBe(1);
    getSubagentLineageIndex(state);
    expect(reads).toBe(2);
  });

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
