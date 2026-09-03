import { describe, expect, it } from "vitest";
import {
  buildCurrentRouteSubtreeProjection,
  createCurrentRouteSubtreeCoordinator,
} from "./tui-route-subtree.js";
import type { ChildSessionState, StatuslineState } from "./state.js";

function child(input: {
  readonly id: string;
  readonly parentID: string;
}): ChildSessionState {
  return {
    id: input.id,
    title: input.id,
    parentID: input.parentID,
    source: "session",
    targetSessionID: input.id,
    status: "running",
    color: "yellow",
    startedAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:01:00.000Z",
  };
}

function stateWith(rows: readonly ChildSessionState[]): StatuslineState {
  return {
    children: Object.fromEntries(rows.map((row) => [row.id, row])),
    countedChildIDs: Object.fromEntries(
      rows.map((row) => [row.targetSessionID ?? row.id, true]),
    ),
    totalExecuted: rows.length,
    updatedAt: "2026-09-02T10:02:00.000Z",
  };
}

function countingCoordinator(counter: { builds: number }) {
  return createCurrentRouteSubtreeCoordinator({
    build: (state, sessionID) => {
      counter.builds += 1;
      return buildCurrentRouteSubtreeProjection(state, sessionID);
    },
  });
}

describe("current-route subtree coordinator", () => {
  it("shares one lineage build across unchanged sidebar token and reconcile reads", () => {
    // Given
    const counter = { builds: 0 };
    const coordinator = countingCoordinator(counter);
    const state = stateWith([child({ id: "ses_child", parentID: "ses_root" })]);

    // When
    const sidebar = coordinator.read({ state, sessionID: "ses_root" });
    const tokenMembership = coordinator.read({ state, sessionID: "ses_root" })
      ?.subtree.executionIDs;
    const reconcileMembership = coordinator.read({ state, sessionID: "ses_root" })
      ?.subtree.executionIDs;

    // Then
    expect(sidebar?.sessionID).toBe("ses_root");
    expect(tokenMembership).toEqual(new Set(["ses_child"]));
    expect(reconcileMembership).toBe(tokenMembership);
    expect(counter.builds).toBe(1);
  });

  it("rebuilds after immutable add delete and reparent state replacements", () => {
    // Given
    const rootChild = child({ id: "ses_child", parentID: "ses_root" });
    const grandchild = child({ id: "ses_grand", parentID: "ses_child" });
    const counter = { builds: 0 };
    const coordinator = countingCoordinator(counter);
    coordinator.read({ state: stateWith([rootChild]), sessionID: "ses_root" });

    // When
    const afterAdd = coordinator.read({
      state: stateWith([rootChild, grandchild]),
      sessionID: "ses_root",
    })?.subtree.executionIDs;
    const afterDelete = coordinator.read({
      state: stateWith([rootChild]),
      sessionID: "ses_root",
    })?.subtree.executionIDs;
    const afterReparent = coordinator.read({
      state: stateWith([
        child({ id: "ses_child", parentID: "ses_other" }),
        grandchild,
      ]),
      sessionID: "ses_root",
    })?.subtree.executionIDs;

    // Then
    expect(afterAdd).toEqual(new Set(["ses_child", "ses_grand"]));
    expect(afterDelete).toEqual(new Set(["ses_child"]));
    expect(afterReparent).toEqual(new Set());
    expect(counter.builds).toBe(4);
  });

  it("rebuilds on route change and replaces descendant membership", () => {
    // Given
    const state = stateWith([
      child({ id: "ses_child", parentID: "ses_root" }),
      child({ id: "ses_other_child", parentID: "ses_other" }),
    ]);
    const counter = { builds: 0 };
    const coordinator = countingCoordinator(counter);
    const before = coordinator.read({ state, sessionID: "ses_root" })?.subtree
      .executionIDs;

    // When
    const after = coordinator.read({ state, sessionID: "ses_other" })?.subtree
      .executionIDs;

    // Then
    expect(before).toEqual(new Set(["ses_child"]));
    expect(after).toEqual(new Set(["ses_other_child"]));
    expect(after).not.toBe(before);
    expect(counter.builds).toBe(2);
  });
});
