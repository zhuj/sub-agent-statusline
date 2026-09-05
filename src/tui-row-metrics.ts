import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

import { formatDuration } from "./render.js";
import type { ChildSessionState } from "./state.js";
import { takeColumns, textColumns, truncateToColumns } from "./text-width.js";

const FALLBACK_SIDEBAR_WIDTH = 34;
const MIN_LABEL_WIDTH = 8;
const MAX_DESCENDANT_DEPTH = 32;
const ROW_MARKER_WIDTH = 4;
const ROW_HEIGHT = { running: 3, terminal: 2, model: 1 } as const;

type RowFormatInput = {
  readonly child: ChildSessionState;
  readonly nowMs: number;
  readonly sidebarWidth?: number;
  readonly reservedWidth?: number;
  readonly indentationWidth?: number;
};

export type SidebarScrollRowLayout = {
  readonly id: string;
  readonly height: number;
};

type TuiRowMetricBase = {
  readonly child: ChildSessionState;
  readonly indentationWidth: number;
  readonly contentWidth: number;
  readonly height: number;
  readonly modelLine?: string;
  readonly layout: SidebarScrollRowLayout;
};

export type TuiRowMetric = TuiRowMetricBase &
  (
    | {
        readonly kind: "running";
        readonly line: ReturnType<typeof formatChildRowLine>;
      }
    | {
        readonly kind: "terminal";
        readonly line: ReturnType<typeof formatTerminalChildRowLine>;
      }
  );

export type BuildTuiRowMetricsInput = {
  readonly children: readonly ChildSessionState[];
  readonly childrenByID: Readonly<Record<string, ChildSessionState>>;
  readonly expanded: boolean;
  readonly nowMs: number;
  readonly sidebarWidth?: number;
  readonly providers: TuiPluginApi["state"]["provider"];
  readonly ancestorSessionID: string;
};

function elapsedMs(child: ChildSessionState, nowMs: number): number {
  if (child.status !== "running") return child.elapsedMs ?? 0;
  const started = Date.parse(child.startedAt);
  if (Number.isNaN(started)) return child.elapsedMs ?? 0;
  return Math.max(0, nowMs - started);
}

function splitParentheticalTitle(title: string): {
  label: string;
  parenthetical?: string;
} {
  const match = title.match(/^(.*?)\s*(\([^)]*\))\s*$/);
  if (!match) return { label: title };
  const label = match[1]?.trim();
  const parenthetical = match[2]?.trim();
  return label && parenthetical ? { label, parenthetical } : { label: title };
}

function childPrimaryText(child: ChildSessionState): string {
  return child.summary?.trim() || child.title;
}

function childParenthetical(child: ChildSessionState): string | undefined {
  if (child.agentName?.trim()) return `(${child.agentName.trim()})`;
  const primary = splitParentheticalTitle(childPrimaryText(child));
  return primary.parenthetical ?? splitParentheticalTitle(child.title).parenthetical;
}

function formatSecondaryLine(
  continuation: string | undefined,
  parenthetical: string | undefined,
  width: number,
): string | undefined {
  if (!continuation) return parenthetical;
  if (!parenthetical) return continuation;
  const parentheticalWidth = Math.min(textColumns(parenthetical), width);
  const continuationWidth = width - parentheticalWidth - 1;
  if (continuationWidth >= MIN_LABEL_WIDTH) {
    return `${truncateToColumns(continuation, continuationWidth)} ${truncateToColumns(parenthetical, parentheticalWidth)}`;
  }
  return truncateToColumns(parenthetical, width);
}

function contextVariants(child: ChildSessionState): string[] {
  const storedTotal = child.tokens?.total;
  const input = child.tokens?.input;
  const output = child.tokens?.output;
  const total = typeof storedTotal === "number" && Number.isFinite(storedTotal)
    ? storedTotal
    : typeof input === "number" || typeof output === "number"
      ? Math.max(0, (input ?? 0) + (output ?? 0))
      : undefined;
  const percent = child.tokens?.contextPercent;
  const hasTotal = typeof total === "number" && Number.isFinite(total);
  const hasPercent = typeof percent === "number" && Number.isFinite(percent);
  if (!hasTotal && !hasPercent) return [""];
  const value = Math.max(0, total ?? 0);
  const tokenPart = hasTotal
    ? value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M ctx`
      : value >= 1_000
        ? `${(value / 1_000).toFixed(1)}k ctx`
        : `${Math.round(value)} ctx`
    : "";
  const percentPart = hasPercent ? `${Math.max(0, Math.round(percent))}%` : "";
  return tokenPart && percentPart
    ? [`${tokenPart} ${percentPart}`, percentPart, tokenPart, ""]
    : [tokenPart || percentPart, ""];
}

export function rowWidthBudget(
  input: Omit<RowFormatInput, "child" | "nowMs">,
): number {
  const width = input.sidebarWidth ?? FALLBACK_SIDEBAR_WIDTH;
  const baseWidth = Math.min(width - 4, 52);
  return Math.max(1, baseWidth - (input.indentationWidth ?? 0) - (input.reservedWidth ?? 0));
}

export function wrapCompactText(
  value: string,
  width: number,
  maxLines: number,
): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const lines: string[] = [];
  let remaining = normalized;
  while (textColumns(remaining) > width && lines.length < maxLines - 1) {
    const probe = takeColumns(remaining, width + 1);
    const breakAt = probe.lastIndexOf(" ");
    const breakPrefix = breakAt >= 0 ? probe.slice(0, breakAt) : "";
    const fit = takeColumns(remaining, width);
    const take = breakAt >= 0 && textColumns(breakPrefix) >= MIN_LABEL_WIDTH &&
        textColumns(breakPrefix) <= width ? breakAt : fit.length;
    if (take <= 0) break;
    lines.push(remaining.slice(0, take).trimEnd());
    remaining = remaining.slice(take).trimStart();
  }
  lines.push(lines.length === maxLines - 1
    ? truncateToColumns(remaining, Math.max(1, width))
    : remaining);
  return lines;
}

export function formatChildRowLine(input: RowFormatInput): {
  labelLines: string[];
  secondaryLine?: string;
  elapsed: string;
  meta: string;
} {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = rowWidthBudget(input);
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);
  for (const meta of contextVariants(input.child)) {
    const detailChars = 2 + textColumns(elapsed) + (meta ? 3 + textColumns(meta) : 0);
    const labelBudget = Math.min(width - 2, width - Math.max(0, detailChars - width));
    if (labelBudget >= MIN_LABEL_WIDTH || textColumns(meta) === 0) {
      const labelLines = wrapCompactText(title.label, Math.max(1, labelBudget), 2);
      return {
        labelLines,
        secondaryLine: formatSecondaryLine(labelLines[1], parenthetical,
          Math.max(1, labelBudget)),
        elapsed,
        meta,
      };
    }
  }
  const labelLines = wrapCompactText(title.label, MIN_LABEL_WIDTH, 2);
  return {
    labelLines,
    secondaryLine: formatSecondaryLine(labelLines[1], parenthetical,
      MIN_LABEL_WIDTH),
    elapsed,
    meta: "",
  };
}

export function formatTerminalChildRowLine(
  input: RowFormatInput,
): { label: string; meta: string } {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = rowWidthBudget(input);
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);
  const labelSource = parenthetical ? `${title.label} ${parenthetical}` : title.label;
  const context = contextVariants(input.child).find((variant) => variant.length > 0);
  return {
    label: truncateToColumns(labelSource, width),
    meta: context ? `${elapsed} ${context}` : elapsed,
  };
}

export function subagentRowHeight(input: RowFormatInput): number {
  const modelHeight = input.child.model?.variant ? ROW_HEIGHT.model : 0;
  if (input.child.status !== "running") return ROW_HEIGHT.terminal + modelHeight;
  const line = formatChildRowLine(input);
  return (line.secondaryLine ? ROW_HEIGHT.running : ROW_HEIGHT.running - 1) + modelHeight;
}

export function formatChildModelLine(
  child: ChildSessionState,
  providers: TuiPluginApi["state"]["provider"],
  width: number,
): string | undefined {
  if (!child.model?.variant) return undefined;
  const provider = providers.find((candidate) => candidate.id === child.model?.providerID);
  const name = provider?.models[child.model.modelID]?.name || child.model.modelID;
  return truncateToColumns(`${name} · ${child.model.variant}`, Math.max(1, width));
}

export function buildTuiRowMetrics(
  input: BuildTuiRowMetricsInput,
): ReadonlyMap<string, TuiRowMetric> {
  if (!input.expanded) return new Map();
  const projection = input.children.map((child) => {
    let depth = 0;
    let parentID = child.parentID;
    const visited = new Set<string>();
    while (parentID !== input.ancestorSessionID) {
      if (depth >= MAX_DESCENDANT_DEPTH || visited.has(parentID)) break;
      visited.add(parentID);
      const parent = input.childrenByID[parentID];
      if (!parent) break;
      depth += 1;
      parentID = parent.parentID;
    }
    return { child, indentationWidth: depth * 2 };
  });
  const metrics = new Map<string, TuiRowMetric>();
  for (const { child, indentationWidth } of projection) {
    const formatInput = { child, nowMs: input.nowMs, sidebarWidth: input.sidebarWidth,
      reservedWidth: ROW_MARKER_WIDTH, indentationWidth };
    const contentWidth = rowWidthBudget(formatInput);
    const modelLine = formatChildModelLine(child, input.providers, contentWidth);
    const modelHeight = modelLine ? ROW_HEIGHT.model : 0;
    if (child.status === "running") {
      const line = formatChildRowLine(formatInput);
      const height = (line.secondaryLine ? ROW_HEIGHT.running : ROW_HEIGHT.running - 1) + modelHeight;
      metrics.set(child.id, { child, indentationWidth, contentWidth, height, modelLine,
        layout: { id: child.id, height }, kind: "running", line });
    } else {
      const line = formatTerminalChildRowLine(formatInput);
      const height = ROW_HEIGHT.terminal + modelHeight;
      metrics.set(child.id, { child, indentationWidth, contentWidth, height, modelLine,
        layout: { id: child.id, height }, kind: "terminal", line });
    }
  }
  return metrics;
}
