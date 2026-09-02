import {
  correlateSubagentWorkItems,
  mergeProxyMetadataWithRealExecution,
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

export function buildCanonicalRows(children: ChildSessionState[]): ChildSessionState[] {
  return correlateSubagentWorkItems(children).map(({ real, proxies }) =>
    proxies.reduce(
      (current, proxy) => mergeProxyMetadataWithRealExecution(current, proxy),
      real,
    ),
  );
}

function computeRetainedCounts(rows: ChildSessionState[]): StatusCounts {
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
