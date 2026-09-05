import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { expect, it } from "vitest";

import type { ChildSessionState } from "./state.js";
import { textColumns } from "./text-width.js";
import {
  buildTuiRowMetrics,
  formatChildModelLine,
  formatTerminalChildRowLine,
} from "./tui-row-metrics.js";

const child = (
  overrides: Partial<ChildSessionState> = {},
): ChildSessionState => ({
  id: "ses_child",
  title: "Child",
  parentID: "ses_parent",
  source: "session",
  targetSessionID: "ses_child",
  status: "running",
  color: "yellow",
  startedAt: "2026-04-30T10:00:00.000Z",
  updatedAt: "2026-04-30T10:00:00.000Z",
  ...overrides,
});

it("builds one Unicode-correct metric per expanded row", () => {
  // Given: an expanded list containing a nested Unicode row.
  const providers: TuiPluginApi["state"]["provider"] = [];

  // When: shared row metrics are built.
  const children = [
    child({
      id: "ses_cjk",
      parentID: "ses_nested_parent",
      title: "日本語é🙂",
    }),
    child({ id: "ses_nested_parent", parentID: "ses_parent" }),
  ];
  const metrics = buildTuiRowMetrics({
    children,
    childrenByID: Object.fromEntries(children.map((item) => [item.id, item])),
    expanded: true,
    nowMs: 1,
    sidebarWidth: 18,
    providers,
    ancestorSessionID: "ses_parent",
  });

  // Then: each row has one keyed metric with depth-aware column bounds.
  const metric = metrics.get("ses_cjk");
  expect(metrics.size).toBe(2);
  expect(metric?.indentationWidth).toBe(2);
  expect(metric?.kind).toBe("running");
  if (metric?.kind !== "running") {
    throw new Error("expected a running metric");
  }
  expect(textColumns(metric.line.labelLines[0] ?? "")).toBeLessThanOrEqual(
    metric.contentWidth,
  );
});

it("skips layout-only formatting while collapsed and rebuilds on expansion", () => {
  // Given: one visible child and no providers.
  const providers: TuiPluginApi["state"]["provider"] = [];
  const input = {
    children: [child()],
    childrenByID: { ses_child: child() },
    nowMs: 1,
    providers,
    ancestorSessionID: "ses_parent",
  };

  // When: metrics are requested while collapsed and then expanded.
  const collapsed = buildTuiRowMetrics({ ...input, expanded: false });
  const expanded = buildTuiRowMetrics({ ...input, expanded: true });

  // Then: collapsed mode performs no row work and expansion rebuilds it.
  expect(collapsed.size).toBe(0);
  expect(expanded.size).toBe(1);
});

it("preserves descendant metrics when its terminal ancestor is hidden", () => {
  // Given: a visible running child beneath a terminal row omitted from visibility.
  const providers: TuiPluginApi["state"]["provider"] = [];
  const hiddenParent = child({
    id: "ses_hidden",
    status: "done",
    color: "green",
  });
  const visibleChild = child({
    id: "ses_visible",
    parentID: hiddenParent.id,
    title: "abcdefghij klmnopqrstuv",
  });
  const childrenByID = {
    [hiddenParent.id]: hiddenParent,
    [visibleChild.id]: visibleChild,
  };
  const sharedInput = {
    childrenByID,
    expanded: true,
    nowMs: 1,
    sidebarWidth: 18,
    providers,
    ancestorSessionID: "ses_parent",
  };

  // When: metrics are built with and without the hidden parent in visible rows.
  const fullMetric = buildTuiRowMetrics({
    ...sharedInput,
    children: [hiddenParent, visibleChild],
  }).get(visibleChild.id);
  const filteredMetric = buildTuiRowMetrics({
    ...sharedInput,
    children: [visibleChild],
  }).get(visibleChild.id);

  // Then: ancestry, wrapping, row height, and anchor layout remain identical.
  expect(filteredMetric).toEqual(fullMetric);
  expect(filteredMetric?.indentationWidth).toBe(2);
});

it("preserves the terminal-label ellipsis when truncation starts at a space", () => {
  // Given: a terminal label whose final content column is whitespace.
  const width = 8;

  // When: the terminal label is formatted to the available width.
  const terminal = formatTerminalChildRowLine({
    child: child({ title: "abcdef ghijklmnop", status: "done" }),
    nowMs: 1,
    sidebarWidth: 12,
  });

  // Then: trailing whitespace is trimmed before the ellipsis is appended.
  expect(terminal.label).toBe("abcdef…");
  expect(terminal.label.endsWith("…")).toBe(true);
  expect(textColumns(terminal.label)).toBeLessThanOrEqual(width);
});

it("preserves the model-line ellipsis when truncation starts at a space", () => {
  // Given: model metadata whose final content column is whitespace.
  const width = 8;
  const providers: TuiPluginApi["state"]["provider"] = [];

  // When: the model line is formatted to the available width.
  const model = formatChildModelLine(
    child({
      model: {
        providerID: "missing",
        modelID: "abcdef",
        variant: "high",
      },
    }),
    providers,
    width,
  );

  // Then: trailing whitespace is trimmed before the ellipsis is appended.
  expect(model).toBe("abcdef…");
  expect(model?.endsWith("…")).toBe(true);
  expect(textColumns(model ?? "")).toBeLessThanOrEqual(width);
});
