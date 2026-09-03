import {
  classifySubagentWorkItem,
  correlateSubagentWorkItems,
  mergeProxyMetadataWithRealExecution,
  trustedTargetSessionID,
} from "./subagent-classification.js";
import type { ChildSessionState, StatuslineState, StatusCounts } from "./state.js";

export interface SubagentProjection {
  // Canonical collapsed rows (real executions with merged proxy metadata),
  // ordered by first real occurrence, then by execution ID stability.
  canonicalRows: ChildSessionState[];
  // Lookup by execution ID (first real occurrence wins for duplicates).
  rowByExecutionID: Map<string, ChildSessionState>;
  // Lookup by child id (original state child id, before collapse merge).
  rowByChildID: Map<string, ChildSessionState>;
  // Stable ordered execution IDs derived from canonical rows.
  orderedExecutionIDs: string[];
  // Retained status counts computed from canonical real executions only.
  retainedCounts: StatusCounts;
  // Total real execution count (retained-only; excludes wrappers/proxies).
  totalExecuted: number;
}

export interface SubagentLineageIndex {
  readonly rowsByParentID: ReadonlyMap<
    string,
    readonly ChildSessionState[]
  >;
  readonly authoritativeSessionIDs: ReadonlySet<string>;
}

export interface SubagentTreeRow {
  readonly child: ChildSessionState;
  readonly depth: number;
  readonly parentSessionID: string;
}

export interface SubagentSubtreeProjection {
  readonly rows: readonly SubagentTreeRow[];
  readonly canonicalRows: readonly ChildSessionState[];
  readonly executionIDs: ReadonlySet<string>;
  readonly retainedCounts: StatusCounts;
}

export function getSubagentLineageIndex(
  state: StatuslineState,
): SubagentLineageIndex {
  const rowsByParentID = new Map<string, ChildSessionState[]>();
  const authoritativeSessionIDs = new Set<string>();
  for (const row of Object.values(state.children)) {
    const siblings = rowsByParentID.get(row.parentID);
    if (siblings) siblings.push(row);
    else rowsByParentID.set(row.parentID, [row]);

    if (classifySubagentWorkItem(row).kind === "real-execution") {
      authoritativeSessionIDs.add(row.id);
    }
  }

  return {
    rowsByParentID,
    authoritativeSessionIDs,
  };
}

export function projectSubagentSubtree(input: {
  readonly index: SubagentLineageIndex;
  readonly rootSessionID: string;
  readonly compareSiblings: (
    left: ChildSessionState,
    right: ChildSessionState,
  ) => number;
}): SubagentSubtreeProjection {
  const scopedRows: ChildSessionState[] = [];
  const pendingParentIDs = [input.rootSessionID];
  const visitedSessionIDs = new Set([input.rootSessionID]);

  while (pendingParentIDs.length > 0) {
    const parentSessionID = pendingParentIDs.pop();
    if (parentSessionID === undefined) continue;

    const children = input.index.rowsByParentID.get(parentSessionID) ?? [];
    for (const child of children) {
      if (classifySubagentWorkItem(child).kind !== "real-execution") {
        scopedRows.push(child);
        continue;
      }
      if (visitedSessionIDs.has(child.id)) continue;

      visitedSessionIDs.add(child.id);
      scopedRows.push(child);
      pendingParentIDs.push(child.id);
    }
  }

  const lineageIDsByExecutionID = new Map<string, string[]>();
  for (const row of scopedRows) {
    const classification = classifySubagentWorkItem(row);
    if (classification.kind !== "real-execution") continue;

    const lineageIDs = lineageIDsByExecutionID.get(classification.executionID);
    if (lineageIDs) lineageIDs.push(row.id);
    else lineageIDsByExecutionID.set(classification.executionID, [row.id]);
  }

  const canonicalByParentID = new Map<string, ChildSessionState[]>();
  for (const row of buildCanonicalRows(scopedRows)) {
    const siblings = canonicalByParentID.get(row.parentID);
    if (siblings) siblings.push(row);
    else canonicalByParentID.set(row.parentID, [row]);
  }
  const rows: SubagentTreeRow[] = [];
  const executionIDs = new Set<string>();
  const stack: Array<{
    readonly child: ChildSessionState;
    readonly depth: number;
  }> = [];
  const rootChildren = [...(canonicalByParentID.get(input.rootSessionID) ?? [])];
  rootChildren.sort(input.compareSiblings);
  for (let index = rootChildren.length - 1; index >= 0; index -= 1) {
    const child = rootChildren[index];
    if (child) stack.push({ child, depth: 0 });
  }

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const executionID = trustedTargetSessionID(current.child) ?? current.child.id;
    if (executionIDs.has(executionID)) continue;
    executionIDs.add(executionID);
    rows.push({
      child: current.child,
      depth: current.depth,
      parentSessionID: current.child.parentID,
    });

    const lineageIDs = lineageIDsByExecutionID.get(executionID) ?? [current.child.id];
    const children: ChildSessionState[] = [];
    const childExecutionIDs = new Set<string>();
    for (const lineageID of lineageIDs) {
      for (const child of canonicalByParentID.get(lineageID) ?? []) {
        const childExecutionID = trustedTargetSessionID(child) ?? child.id;
        if (childExecutionIDs.has(childExecutionID)) continue;
        childExecutionIDs.add(childExecutionID);
        children.push(child);
      }
    }
    children.sort(input.compareSiblings);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push({ child, depth: current.depth + 1 });
    }
  }

  const canonicalRows = rows.map(({ child }) => child);
  return {
    rows,
    canonicalRows,
    executionIDs,
    retainedCounts: computeRetainedCounts(canonicalRows),
  };
}

export function buildCanonicalRows(children: ChildSessionState[]): ChildSessionState[] {
  return correlateSubagentWorkItems(children).map(({ real, proxies }) =>
    proxies.reduce(
      (current, proxy) => mergeProxyMetadataWithRealExecution(current, proxy),
      real,
    ),
  );
}

function computeRetainedCounts(rows: readonly ChildSessionState[]): StatusCounts {
  const counts: StatusCounts = { running: 0, done: 0, error: 0 };
  for (const row of rows) {
    if (row.status === "running") counts.running += 1;
    else if (row.status === "done") counts.done += 1;
    else if (row.status === "error") counts.error += 1;
  }
  return counts;
}

export function buildSubagentProjectionFromChildren(
  children: ChildSessionState[],
): SubagentProjection {
  const canonicalRows = buildCanonicalRows(children);

  const rowByExecutionID = new Map<string, ChildSessionState>();
  const orderedExecutionIDs: string[] = [];
  const seenExecutionIDs = new Set<string>();
  for (const row of canonicalRows) {
    const executionID = row.targetSessionID ?? row.id;
    rowByExecutionID.set(executionID, row);
    if (!seenExecutionIDs.has(executionID)) {
      seenExecutionIDs.add(executionID);
      orderedExecutionIDs.push(executionID);
    }
  }

  const rowByChildID = new Map<string, ChildSessionState>();
  for (const child of children) {
    rowByChildID.set(child.id, child);
  }

  const retainedCounts = computeRetainedCounts(canonicalRows);
  const totalExecuted = orderedExecutionIDs.length;

  return {
    canonicalRows,
    rowByExecutionID,
    rowByChildID,
    orderedExecutionIDs,
    retainedCounts,
    totalExecuted,
  };
}

const RECENT_TERMINAL_VISIBLE_MS = 10 * 60 * 1000;

function isTerminalWorkItem(child: ChildSessionState): boolean {
  return child.status === "done" || child.status === "error";
}

export function isVisibleWorkItem(
  child: ChildSessionState,
  nowMs = Date.now(),
): boolean {
  if (!isTerminalWorkItem(child)) return true;
  const endedMs = Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endedMs)) return false;
  return nowMs - endedMs <= RECENT_TERMINAL_VISIBLE_MS;
}

export interface VisibleSubagentWorkItemsOptions {
  showCompletedHistory?: boolean;
}

// Projection-aware visibility filter that does NOT rebuild correlation.
// When given canonical rows directly (from an existing projection), it
// applies only the visibility/filter rules without calling
// buildSubagentProjectionFromChildren again.
export function filterVisibleFromCanonical(
  canonicalRows: ChildSessionState[],
  nowMs = Date.now(),
  options: VisibleSubagentWorkItemsOptions = {},
): ChildSessionState[] {
  if (options.showCompletedHistory) return canonicalRows;

  // Single pass: keep row if currently visible, collect active-message IDs from
  // any currently-running rows (terminal rows that share a messageID with a
  // running row are kept as "transitional" output alongside the active one).
  const visible: ChildSessionState[] = [];
  const activeMessageIDs = new Set<string>();
  for (const child of canonicalRows) {
    if (!isVisibleWorkItem(child, nowMs)) continue;
    visible.push(child);
    if (child.status === "running" && child.messageID) {
      activeMessageIDs.add(child.messageID);
    }
  }

  if (activeMessageIDs.size === 0) return visible;

  return visible.filter((child) => {
    if (child.status === "running") return true;
    if (!child.messageID) return false;
    return activeMessageIDs.has(child.messageID);
  });
}

export function buildSubagentProjection(
  state: StatuslineState,
): SubagentProjection {
  return buildSubagentProjectionFromChildren(Object.values(state.children));
}
