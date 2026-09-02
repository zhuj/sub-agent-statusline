import {
  buildCanonicalRows,
  buildSubagentProjectionFromChildren,
  filterVisibleFromCanonical,
  isVisibleWorkItem as projectionIsVisibleWorkItem,
  type VisibleSubagentWorkItemsOptions,
} from "./projection.js";
import type { ChildSessionState, StatuslineState } from "./state.js";
import {
  formatCompactPercentUsed,
  formatCompactTokenCount,
  formatDuration,
  formatNumber,
  formatPercentUsed,
  formatTokenCount,
} from "./format.js";

export { formatDuration } from "./format.js";

const ansi = {
  reset: "\u001B[0m",
  gray: "\u001B[90m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
};

function colorsEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  const fromEnv = process.env.OPENCODE_SUBAGENT_STATUSLINE_COLOR;
  if (fromEnv === "0") return false;
  return true;
}

function paint(text: string, color: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${color}${text}${ansi.reset}`;
}

function resolveTokenTotal(child: ChildSessionState): number | undefined {
  const total = child.tokens?.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }

  const inTokens = child.tokens?.input;
  const outTokens = child.tokens?.output;
  if (typeof inTokens === "number" || typeof outTokens === "number") {
    return (inTokens ?? 0) + (outTokens ?? 0);
  }

  return undefined;
}

export function formatContextDetails(
  child: ChildSessionState,
): string | undefined {
  const total = resolveTokenTotal(child);
  const percent = child.tokens?.contextPercent;

  const hasPercent = typeof percent === "number" && Number.isFinite(percent);
  const hasTotal = typeof total === "number" && Number.isFinite(total);

  if (hasTotal && hasPercent) {
    return `${formatTokenCount(total)} · ${formatPercentUsed(percent)}`;
  }

  if (hasTotal) {
    return formatTokenCount(total);
  }

  if (hasPercent) {
    return formatPercentUsed(percent);
  }

  return undefined;
}

export function formatContext(child: ChildSessionState): string {
  const details = formatContextDetails(child);
  if (!details) return "";
  return `ctx ${details}`;
}

export function formatContextCompact(child: ChildSessionState): string {
  const total = resolveTokenTotal(child);
  const percent = child.tokens?.contextPercent;

  const hasPercent = typeof percent === "number" && Number.isFinite(percent);
  const hasTotal = typeof total === "number" && Number.isFinite(total);

  if (hasTotal && hasPercent) {
    return `${formatCompactTokenCount(total)} ${formatCompactPercentUsed(percent)}`;
  }

  if (hasTotal) {
    return formatCompactTokenCount(total);
  }

  if (hasPercent) {
    return formatCompactPercentUsed(percent);
  }

  return "";
}

function childColor(child: ChildSessionState): string {
  if (child.color === "green") return ansi.green;
  if (child.color === "red") return ansi.red;
  return ansi.yellow;
}

export function byPriority(a: ChildSessionState, b: ChildSessionState): number {
  const startedDiff = b.startedAt.localeCompare(a.startedAt);
  if (startedDiff !== 0) return startedDiff;

  // Keep execution-order ties stable across running async status/token updates.
  return a.id.localeCompare(b.id);
}

// Re-export projection primitives to keep a single source of truth while
// preserving the existing public render-module surface.
export const isVisibleWorkItem = projectionIsVisibleWorkItem;
export const collapseSubagentWorkItems = buildCanonicalRows;

// `visibleSubagentWorkItems` accepts raw (pre-correlation) children so existing
// callers — including the test suite — can pass state.children-shaped arrays.
export function visibleSubagentWorkItems(
  children: ChildSessionState[],
  nowMs = Date.now(),
  options: VisibleSubagentWorkItemsOptions = {},
): ChildSessionState[] {
  return filterVisibleFromCanonical(
    buildCanonicalRows(children),
    nowMs,
    options,
  );
}

export function renderStatusLine(state: StatuslineState): string {
  const projection = buildSubagentProjectionFromChildren(
    Object.values(state.children),
  );
  const children = filterVisibleFromCanonical(projection.canonicalRows).sort(
    byPriority,
  );
  const counts = projection.retainedCounts;
  const totalExecuted = formatNumber(projection.totalExecuted ?? 0);
  const colorOn = colorsEnabled();

  const aggregate = `↳ ${counts.running} running · ${counts.done} done · ${counts.error} error · Σ ${totalExecuted} total`;
  if (children.length === 0) return aggregate;

  const details = children
    .map((child) => {
      const context = formatContext(child);
      const label = [child.title, formatDuration(child.elapsedMs), context]
        .filter((part) => part.length > 0)
        .join(" ");
      return paint(label, childColor(child), colorOn);
    })
    .join(paint(" · ", ansi.gray, colorOn));

  return `${aggregate} · ${details}`;
}

// Avoid unused-import warning on the type-only re-export in test contexts.
export type { VisibleSubagentWorkItemsOptions };
