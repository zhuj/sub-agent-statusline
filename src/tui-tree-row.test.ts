import { describe, expect, it, vi } from "vitest";
import type { SubagentTreeRow } from "./projection.js";
import type { ChildSessionState } from "./state.js";
import {
  activateSubagentTreeRow,
  resolveTreeRowLayout,
  treeRowsLayoutSignature,
} from "./tui-tree-row.js";

function child(overrides: Partial<ChildSessionState> = {}): ChildSessionState {
  return {
    id: "ses_child",
    title: "Child work",
    parentID: "ses_parent",
    source: "session",
    targetSessionID: "ses_child",
    status: "running",
    color: "yellow",
    startedAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:01:00.000Z",
    ...overrides,
  };
}

function row(depth: number): SubagentTreeRow {
  return {
    child: child(),
    depth,
    parentSessionID: "ses_parent",
  };
}

describe("resolveTreeRowLayout", () => {
  it("uses two columns per depth while width permits", () => {
    // Given / When
    const layout = resolveTreeRowLayout({
      depth: 3,
      rowWidth: 40,
      fixedColumns: 4,
      minimumLabelWidth: 8,
    });

    // Then
    expect(layout.indentColumns).toBe(6);
    expect(layout.labelWidth).toBe(30);
  });

  it("clamps deep indentation to preserve the minimum label width", () => {
    // Given / When
    const layout = resolveTreeRowLayout({
      depth: 100,
      rowWidth: 15,
      fixedColumns: 4,
      minimumLabelWidth: 8,
    });

    // Then
    expect(layout.indentColumns).toBe(3);
    expect(layout.labelWidth).toBe(8);
  });

  it("keeps huge depth as presentation metadata rather than visibility", () => {
    // Given / When
    const layout = resolveTreeRowLayout({
      depth: 10_000,
      rowWidth: 8,
      fixedColumns: 4,
      minimumLabelWidth: 8,
    });

    // Then
    expect(layout.indentColumns).toBe(0);
    expect(layout.labelWidth).toBe(8);
  });

  it("normalizes negative geometry without producing negative widths", () => {
    // Given / When
    const layout = resolveTreeRowLayout({
      depth: -3,
      rowWidth: -1,
      fixedColumns: -2,
      minimumLabelWidth: 8,
    });

    // Then
    expect(layout).toEqual({ indentColumns: 0, labelWidth: 8 });
  });
});

describe("treeRowsLayoutSignature", () => {
  it("changes when only row depth changes", () => {
    // Given
    const shallow = [row(0)];
    const nested = [row(1)];

    // When
    const shallowSignature = treeRowsLayoutSignature(shallow);
    const nestedSignature = treeRowsLayoutSignature(nested);

    // Then
    expect(nestedSignature).not.toBe(shallowSignature);
  });
});

describe("activateSubagentTreeRow", () => {
  it("records the immediate parent before canonical navigation", () => {
    // Given
    const remember = vi.fn();
    const navigate = vi.fn();
    const nestedRow: SubagentTreeRow = {
      child: child({
        id: "ses_grand",
        parentID: "ses_child",
        targetSessionID: "ses_canonical_grand",
      }),
      depth: 1,
      parentSessionID: "ses_child",
    };

    // When
    activateSubagentTreeRow({
      row: nestedRow,
      showCompletedHistory: true,
      remember,
      navigate,
    });

    // Then
    expect(remember).toHaveBeenCalledWith({
      parentSessionID: "ses_child",
      childSessionID: "ses_canonical_grand",
      childRowID: "ses_grand",
      showCompletedHistory: true,
    });
    expect(navigate).toHaveBeenCalledExactlyOnceWith("ses_canonical_grand");
  });

  it("keeps the immediate parent when synthetic correlation supplies navigation", () => {
    // Given
    const remember = vi.fn();
    const navigate = vi.fn();
    const correlatedRow: SubagentTreeRow = {
      child: child({
        id: "tool:synthetic",
        parentID: "ses_viewed_root",
        source: "tool",
        targetSessionID: "ses_real_target",
      }),
      depth: 2,
      parentSessionID: "ses_immediate_parent",
    };

    // When
    activateSubagentTreeRow({
      row: correlatedRow,
      showCompletedHistory: false,
      remember,
      navigate,
    });

    // Then
    expect(remember).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionID: "ses_immediate_parent" }),
    );
    expect(navigate).toHaveBeenCalledExactlyOnceWith("ses_real_target");
  });

  it("does not navigate an untrusted target", () => {
    // Given
    const remember = vi.fn();
    const navigate = vi.fn();

    // When
    activateSubagentTreeRow({
      row: {
        child: child({
          id: "tool:synthetic",
          source: "tool",
          targetSessionID: "not-a-session",
        }),
        depth: 1,
        parentSessionID: "ses_parent",
      },
      showCompletedHistory: false,
      remember,
      navigate,
    });

    // Then
    expect(remember).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
