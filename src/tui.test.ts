import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { describe, expect, it, vi } from "vitest";

import tuiPlugin, {
  backfillHydratedTargetSessionIDs,
  formatChildModelLine,
  formatChildRowLine,
  formatTerminalChildRowLine,
  hydratePreviousSubagents,
  preservedSidebarAnchorScrollTop,
  preservedSidebarScrollTop,
  resolveSidebarSubagentSnapshot,
  probeRunningEvidence,
  resumeKnownBusySessions,
  discoverCachedBusyDescendants,
  resolveTuiSubagentSnapshot,
  rowWidthBudget,
  subagentRowHeight,
  wrapCompactText,
} from "./tui.js";
import { textColumns } from "./text-width.js";
import {
  focusPromptWithDeferredRetry,
  resolveSidebarReturnFocusAction,
  resolveSiblingSidebarRefocus,
  shouldReleaseSidebarListFocus,
} from "./tui-focus.js";
import { registerSubagentCommands } from "./tui-commands.js";
import { createHydrationTransactionIndex } from "./tui-hydration-index.js";
import type { ChildSessionState, StatuslineState } from "./state.js";

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
    updatedAt: "2026-04-30T10:01:00.000Z",
    ...overrides,
  };
}

function stateWith(
  children: ChildSessionState[],
  countedChildIDs = children
    .filter((item) => item.source === "session" || item.id.startsWith("ses_"))
    .map((item) => item.targetSessionID ?? item.id),
): StatuslineState {
  return {
    children: Object.fromEntries(children.map((item) => [item.id, item])),
    countedChildIDs: Object.fromEntries(
      countedChildIDs.map((id) => [id, true]),
    ),
    totalExecuted: 99,
    updatedAt: "2026-04-30T10:20:00.000Z",
  };
}

it.each(["busy", "retry"])("recovers known terminal sessions from %s polling evidence", (type) => {
  const current = stateWith([
    child({ id: "ses_parent", parentID: "ses_root", status: "done" }),
    child({ id: "ses_leaf", parentID: "ses_parent", status: "done", tokens: { total: 42 } }),
    child({ id: "tool:history", targetSessionID: "ses_leaf", status: "done" }),
  ]);
  const snapshot = { ...current, children: { ...current.children } };
  expect(resumeKnownBusySessions(current, snapshot, {
    ses_leaf: { type }, ses_unknown: { type }, "tool:history": { type },
  })).toBe(true);
  expect(current.children.ses_leaf).toMatchObject({ status: "running", tokens: { total: 42 } });
  expect(current.children.ses_parent?.status).toBe("done");
  expect(current.children["tool:history"]?.status).toBe("done");
  expect(current.children.ses_unknown).toBeUndefined();
  expect(current.totalExecuted).toBe(snapshot.totalExecuted);
});

it("rejects recovery based on an obsolete terminal revision", () => {
  const snapshot = stateWith([child({ id: "ses_leaf", status: "done" })]);
  const current = stateWith([child({
    id: "ses_leaf", status: "done", updatedAt: "2026-04-30T11:00:00.000Z",
  })]);
  expect(resumeKnownBusySessions(current, snapshot, { ses_leaf: { type: "busy" } })).toBe(false);
  expect(current.children.ses_leaf?.status).toBe("done");
});

it("recovers absent terminal ancestors without reading unrelated completed metadata", () => {
  const state = stateWith([]);
  const metadata: Record<string, unknown> = {
    ses_leaf: { id: "ses_leaf", parentID: "ses_parent", title: "Leaf" },
    ses_sibling: { id: "ses_sibling", parentID: "ses_parent", title: "Sibling" },
    ses_parent: { id: "ses_parent", parentID: "ses_grandparent", title: "Parent" },
    ses_grandparent: { id: "ses_grandparent", parentID: "ses_root", title: "Grandparent" },
  };
  const readSession = vi.fn((id: string) => metadata[id]);
  const statuses = {
    ses_leaf: { type: "busy" }, ses_sibling: { type: "retry" },
    ses_parent: { type: "idle" }, ses_grandparent: { type: "idle" },
    ses_unrelated: { type: "idle" },
  };
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(true);
  expect(state.children.ses_parent?.status).toBe("done");
  expect(state.children.ses_grandparent?.status).toBe("done");
  expect(state.children.ses_leaf?.status).toBe("running");
  expect(state.children.ses_sibling?.status).toBe("running");
  expect(readSession).toHaveBeenCalledTimes(4);
  expect(readSession).not.toHaveBeenCalledWith("ses_unrelated");
  const snapshot = resolveTuiSubagentSnapshot({ state, sessionID: "ses_root" });
  expect(snapshot.visibleChildren.map((item) => item.id)).toEqual(expect.arrayContaining(["ses_leaf", "ses_sibling"]));
  readSession.mockClear();
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(false);
  expect(readSession).not.toHaveBeenCalled();
});

it("recovers missing completed ancestors without scanning unrelated terminal metadata", () => {
  const state = stateWith([]);
  const metadata: Record<string, unknown> = {
    ses_leaf: { id: "ses_leaf", parentID: "ses_parent", title: "Leaf" },
    ses_sibling: { id: "ses_sibling", parentID: "ses_parent", title: "Sibling" },
    ses_parent: { id: "ses_parent", parentID: "ses_grandparent", title: "Parent" },
    ses_grandparent: { id: "ses_grandparent", parentID: "ses_root", title: "Grandparent" },
  };
  const statuses = {
    ses_leaf: { type: "busy" }, ses_sibling: { type: "retry" },
    ses_parent: { type: "idle" }, ses_grandparent: { type: "error" },
    ses_unrelated: { type: "idle" },
  };
  const readSession = vi.fn((id: string) => metadata[id]);
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(true);
  expect(Object.keys(state.children)).toEqual(["ses_grandparent", "ses_parent", "ses_leaf", "ses_sibling"]);
  expect(state.children.ses_grandparent?.status).toBe("error");
  expect(state.children.ses_parent?.status).toBe("done");
  expect(state.children.ses_leaf?.status).toBe("running");
  expect(state.children.ses_sibling?.status).toBe("running");
  expect(readSession).toHaveBeenCalledTimes(4);
  readSession.mockClear();
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(false);
  expect(readSession).not.toHaveBeenCalled();
});

it("does not guess an unknown ancestor's status", () => {
  const state = stateWith([]);
  const readSession = vi.fn((id: string) => ({ id, parentID: "ses_unknown" }));
  expect(discoverCachedBusyDescendants(state, "ses_root", { ses_leaf: { type: "busy" } }, readSession)).toBe(false);
  expect(readSession).toHaveBeenCalledExactlyOnceWith("ses_leaf");
  expect(Object.keys(state.children)).toEqual([]);
});

it("discovers cached active descendants below completed parents in ancestry order", () => {
  const state = stateWith([child({ id: "ses_parent", parentID: "ses_root", status: "done" })]);
  const metadata: Record<string, unknown> = {
    ses_leaf: { id: "ses_leaf", parentID: "ses_parent", title: "Leaf" },
    ses_nested: { id: "ses_nested", parentID: "ses_leaf", title: "Nested" },
    ses_unrelated: { id: "ses_unrelated", parentID: "ses_other_root", title: "Other" },
  };
  const readSession = vi.fn((id: string) => metadata[id]);
  const statuses = {
    ses_nested: { type: "retry" }, ses_leaf: { type: "busy" },
    ses_unrelated: { type: "busy" }, ses_missing: { type: "busy" },
    ses_idle: { type: "idle" }, ses_root: { type: "busy" },
  };
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(true);
  expect(state.children.ses_leaf?.status).toBe("running");
  expect(state.children.ses_nested?.parentID).toBe("ses_leaf");
  expect(state.children.ses_parent?.status).toBe("done");
  expect(state.children.ses_unrelated).toBeUndefined();
  expect(state.children.ses_missing).toBeUndefined();
  expect(readSession).toHaveBeenCalledTimes(4);
});

it("caps cached discovery at 32 new rows and continues next cycle", () => {
  const state = stateWith([]);
  const statuses = Object.fromEntries(Array.from({ length: 40 }, (_, index) =>
    [`ses_new_${index}`, { type: "busy" }],
  ));
  const readSession = vi.fn((id: string) => ({ id, parentID: "ses_root", title: "New" }));
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(true);
  expect(Object.keys(state.children)).toHaveLength(32);
  readSession.mockClear();
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(true);
  expect(Object.keys(state.children)).toHaveLength(40);
  expect(readSession).toHaveBeenCalledTimes(8);
});

it("discovers ten leaves among 190 completed ancestors without rereading their metadata", () => {
  const state = stateWith(Array.from({ length: 190 }, (_, index) => child({
    id: `ses_saved_${index}`,
    parentID: index % 4 === 0 ? "ses_root" : `ses_saved_${index - 1}`,
    status: "done",
  })));
  const metadata = new Map(Array.from({ length: 10 }, (_, index) => {
    const id = `ses_new_${index}`;
    return [id, { id, parentID: `ses_saved_${index * 4 + 3}`, title: "Active leaf" }];
  }));
  const statuses = Object.fromEntries([...metadata.keys()].map((id) => [id, { type: "busy" }]));
  const readSession = vi.fn((id: string) => metadata.get(id));
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(true);
  expect(readSession).toHaveBeenCalledTimes(10);
  expect(Object.keys(state.children)).toHaveLength(200);
  expect(Object.values(state.children).filter((item) => item.status === "running")).toHaveLength(10);
  readSession.mockClear();
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, readSession)).toBe(false);
  expect(readSession).not.toHaveBeenCalled();
});

it("does not attach cycles or mismatched cached metadata to the current root", () => {
  const state = stateWith([]);
  const metadata: Record<string, unknown> = {
    ses_a: { id: "ses_a", parentID: "ses_b" },
    ses_b: { id: "ses_b", parentID: "ses_a" },
    ses_bad: { id: "ses_different", parentID: "ses_root" },
  };
  const statuses = Object.fromEntries(Object.keys(metadata).map((id) => [id, { type: "busy" }]));
  expect(discoverCachedBusyDescendants(state, "ses_root", statuses, (id) => metadata[id])).toBe(false);
  expect(Object.keys(state.children)).toEqual([]);
});

type HydrateStateInput = {
  children: unknown[];
  childrenByParent?: Record<string, unknown[]>;
  sessionID?: string;
  parentMessages?: unknown[];
  childMessages?: Record<string, unknown[]>;
  statuses?: Record<string, unknown>;
  failChildrenFor?: string[];
};

type HydrateStateResult = {
  state: StatuslineState;
  hydrated: boolean;
  childrenSessionIDs: string[];
};

async function hydrateStateWithResult(
  input: HydrateStateInput,
): Promise<HydrateStateResult> {
  let state = stateWith([]);
  const dir = await mkdtemp(join(tmpdir(), "subagent-statusline-hydrate-"));
  const rootSessionID = input.sessionID ?? "ses_parent";
  const childMessages = input.childMessages ?? {};
  const childrenSessionIDs: string[] = [];
  const api = {
    state: { path: { directory: dir } },
    client: {
      session: {
        children: vi.fn(async ({ sessionID }: { sessionID: string }) => {
          childrenSessionIDs.push(sessionID);
          if (input.failChildrenFor?.includes(sessionID)) {
            throw new Error(`failed to read children for ${sessionID}`);
          }
          return {
            data: input.childrenByParent
              ? (input.childrenByParent[sessionID] ?? [])
              : input.children,
          };
        }),
        messages: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
          data:
            sessionID === rootSessionID
              ? (input.parentMessages ?? [])
              : (childMessages[sessionID] ?? []),
        })),
        status: vi.fn(async () => ({ data: input.statuses ?? {} })),
      },
    },
  } as unknown as TuiPluginApi;

  const hydrated = await hydratePreviousSubagents(
    api,
    rootSessionID,
    (update: (prev: StatuslineState) => StatuslineState) => {
      state = update(state);
    },
  );

  return { state, hydrated, childrenSessionIDs };
}

async function hydrateState(input: HydrateStateInput): Promise<StatuslineState> {
  return (await hydrateStateWithResult(input)).state;
}

describe("TUI subagent snapshots", () => {
  it("wraps unbroken Japanese text within odd terminal column budgets", () => {
    const lines = wrapCompactText("日本語の概要を表示しています追加確認", 25, 2);

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => textColumns(line) <= 25)).toBe(true);
  });

  it("truncates unbroken Japanese text within narrow terminal column budgets", () => {
    const lines = wrapCompactText("日本語の概要を表示しています", 8, 2);

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => textColumns(line) <= 8)).toBe(true);
  });

  it("preserves the re-exported terminal formatter ellipsis exactly", () => {
    // Given: a long terminal label whose last content column is whitespace.
    const width = 8;

    // When: the re-exported formatter truncates the label.
    const line = formatTerminalChildRowLine({
      child: child({ title: "abcdef ghijklmnop", status: "done" }),
      nowMs: 1,
      sidebarWidth: 12,
    });

    // Then: the label preserves the existing trim-before-ellipsis behavior.
    expect(line.label).toBe("abcdef…");
    expect(line.label.endsWith("…")).toBe(true);
    expect(textColumns(line.label)).toBeLessThanOrEqual(width);
  });

  it("matches running row height to rendered secondary-line presence", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");

    expect(
      subagentRowHeight({ child: child({ title: "Short task" }), nowMs }),
    ).toBe(2);
    expect(
      subagentRowHeight({
        child: child({ title: "Short task", agentName: "reviewer" }),
        nowMs,
      }),
    ).toBe(3);
    expect(
      subagentRowHeight({
        child: child({ title: "Short task", status: "done" }),
        nowMs,
      }),
    ).toBe(2);
  });

  it("shows model metadata only with a variant and accounts for layout height", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const plain = child({ title: "Short task" });
    const modeled = child({
      title: "Short task",
      model: { providerID: "openai", modelID: "gpt-5.6", variant: "high" },
    });
    const providers = [{
      id: "openai",
      models: { "gpt-5.6": { name: "GPT 5.6" } },
    }] as unknown as TuiPluginApi["state"]["provider"];

    expect(formatChildModelLine(plain, providers, 20)).toBeUndefined();
    expect(
      formatChildModelLine(
        child({ model: { providerID: "openai", modelID: "gpt-5.6" } }),
        providers,
        20,
      ),
    ).toBeUndefined();
    expect(subagentRowHeight({ child: plain, nowMs })).toBe(2);
    expect(formatChildModelLine(modeled, providers, 20)).toBe("GPT 5.6 · high");
    expect(subagentRowHeight({ child: modeled, nowMs })).toBe(3);
    const truncatedModel = formatChildModelLine(
      child({
        model: {
          providerID: "missing",
          modelID: "abcdef",
          variant: "high",
        },
      }),
      providers,
      8,
    );
    expect(truncatedModel).toBe("abcdef…");
    expect(truncatedModel?.endsWith("…")).toBe(true);
    expect(textColumns(truncatedModel ?? "")).toBeLessThanOrEqual(8);
    expect(
      formatChildModelLine(
        child({ model: { providerID: "missing", modelID: "長いモデル識別子", variant: "最大" } }),
        providers,
        12,
      ),
    ).toSatisfy((line: string | undefined) => !!line && textColumns(line) <= 12);
    expect(
      formatChildModelLine(
        child({ model: { providerID: "missing", modelID: "fallback-model", variant: "fast" } }),
        providers,
        40,
      ),
    ).toBe("fallback-model · fast");
  });

  it("subtracts nested indentation from every child text budget", () => {
    // Given: a long child row rendered at a wide sidebar width.
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const modeledChild = child({
      title: "A".repeat(80),
      tokens: { total: 123_456, contextPercent: 78 },
      model: { providerID: "openai", modelID: "long-model", variant: "high" },
    });
    const providers = [{
      id: "openai",
      models: { "long-model": { name: "M".repeat(80) } },
    }] as unknown as TuiPluginApi["state"]["provider"];
    const rootWidth = rowWidthBudget({
      sidebarWidth: 52,
      reservedWidth: 4,
      indentationWidth: 0,
    });
    const nestedWidth = rowWidthBudget({
      sidebarWidth: 52,
      reservedWidth: 4,
      indentationWidth: 8,
    });

    // When: the same row is formatted at depth zero and depth four.
    const rootRunning = formatChildRowLine({
      child: modeledChild,
      nowMs,
      sidebarWidth: 52,
      reservedWidth: 4,
      indentationWidth: 0,
    });
    const nestedRunning = formatChildRowLine({
      child: modeledChild,
      nowMs,
      sidebarWidth: 52,
      reservedWidth: 4,
      indentationWidth: 8,
    });
    const rootTerminal = formatTerminalChildRowLine({
      child: { ...modeledChild, status: "done" },
      nowMs,
      sidebarWidth: 52,
      reservedWidth: 4,
      indentationWidth: 0,
    });
    const nestedTerminal = formatTerminalChildRowLine({
      child: { ...modeledChild, status: "done" },
      nowMs,
      sidebarWidth: 52,
      reservedWidth: 4,
      indentationWidth: 8,
    });
    const rootModel = formatChildModelLine(modeledChild, providers, rootWidth);
    const nestedModel = formatChildModelLine(
      modeledChild,
      providers,
      nestedWidth,
    );

    // Then: every formatted text path receives the smaller nested budget.
    expect(nestedWidth).toBe(rootWidth - 8);
    expect(textColumns(nestedRunning.labelLines[0] ?? "")).toBeLessThan(
      textColumns(rootRunning.labelLines[0] ?? ""),
    );
    expect(textColumns(nestedRunning.labelLines[0] ?? "")).toBeLessThanOrEqual(
      nestedWidth,
    );
    expect(textColumns(nestedRunning.secondaryLine ?? "")).toBeLessThanOrEqual(
      nestedWidth,
    );
    expect(textColumns(nestedTerminal.label)).toBeLessThan(
      textColumns(rootTerminal.label),
    );
    expect(textColumns(nestedTerminal.label)).toBeLessThanOrEqual(nestedWidth);
    expect(textColumns(nestedModel ?? "")).toBeLessThan(
      textColumns(rootModel ?? ""),
    );
    expect(textColumns(nestedModel ?? "")).toBeLessThanOrEqual(nestedWidth);
  });

  it("keeps a nested child within a narrow sidebar budget", () => {
    // Given: an ancestor with a nested child in a narrow sidebar.
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const ancestor = child({
      id: "ses_ancestor",
      parentID: "ses_parent",
      targetSessionID: "ses_ancestor",
      title: "Ancestor",
    });
    const nestedChild = child({
      id: "ses_nested",
      parentID: "ses_ancestor",
      targetSessionID: "ses_nested",
      title: "N".repeat(80),
      agentName: "nested-reviewer",
      tokens: { total: 123_456, contextPercent: 78 },
      model: { providerID: "missing", modelID: "long-model", variant: "high" },
    });
    const snapshot = resolveTuiSubagentSnapshot({
      state: stateWith([ancestor, nestedChild]),
      sessionID: "ses_parent",
      nowMs,
    });
    expect(snapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_ancestor",
      "ses_nested",
    ]);

    const visibleNestedChild = snapshot.visibleChildren.find(
      (item) => item.id === "ses_nested",
    );
    if (!visibleNestedChild) throw new Error("nested child was not projected");

    const sidebarWidth = 16;
    const indentationWidth = 2;
    const reservedWidth = 4;
    const availableWidth = rowWidthBudget({
      sidebarWidth,
      indentationWidth,
      reservedWidth,
    });
    const providers: TuiPluginApi["state"]["provider"] = [];
    const running = formatChildRowLine({
      child: visibleNestedChild,
      nowMs,
      sidebarWidth,
      indentationWidth,
      reservedWidth,
    });
    const terminal = formatTerminalChildRowLine({
      child: { ...visibleNestedChild, status: "done" },
      nowMs,
      sidebarWidth,
      indentationWidth,
      reservedWidth,
    });
    const model = formatChildModelLine(
      visibleNestedChild,
      providers,
      availableWidth,
    );

    // When: the nested child is formatted with its computed indentation reserved.
    // Then: every rendered text line fits the remaining six-column budget.
    expect(availableWidth).toBe(6);
    expect(textColumns(running.labelLines[0] ?? "")).toBeLessThanOrEqual(
      availableWidth,
    );
    expect(running.secondaryLine).toBeDefined();
    expect(textColumns(running.secondaryLine ?? "")).toBeLessThanOrEqual(
      availableWidth,
    );
    expect(textColumns(terminal.label)).toBeLessThanOrEqual(availableWidth);
    expect(textColumns(model ?? "")).toBeLessThanOrEqual(availableWidth);
  });

  it("preserves sidebar scroll with the visible row anchor first", () => {
    expect(
      preservedSidebarAnchorScrollTop({
        expanded: true,
        anchor: {
          childIDs: ["ses_5", "ses_6", "ses_7"],
          intraRowOffset: 1,
        },
        rows: [
          { id: "ses_1", height: 3 },
          { id: "ses_2", height: 3 },
          { id: "ses_5", height: 3 },
          { id: "ses_6", height: 3 },
          { id: "ses_7", height: 3 },
        ],
        scrollTop: 0,
        scrollHeight: 15,
        viewportHeight: 5,
      }),
    ).toBe(7);

    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 99,
        anchor: {
          childIDs: ["ses_removed", "ses_6", "ses_7"],
          intraRowOffset: 1,
        },
        rows: [
          { id: "ses_1", height: 3 },
          { id: "ses_2", height: 3 },
          { id: "ses_6", height: 3 },
          { id: "ses_7", height: 3 },
        ],
        scrollTop: 0,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBe(6);
  });

  it("does not fall back to stale numeric offset when anchor already matches top", () => {
    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 6,
        anchor: {
          childIDs: ["ses_1", "ses_2"],
          intraRowOffset: 0,
        },
        rows: [
          { id: "ses_1", height: 3 },
          { id: "ses_2", height: 3 },
        ],
        scrollTop: 0,
        scrollHeight: 8,
        viewportHeight: 5,
      }),
    ).toBeUndefined();
  });

  it("falls back to bounded numeric sidebar scroll preservation", () => {
    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 99,
        scrollTop: 0,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBe(7);
    expect(
      preservedSidebarScrollTop({
        expanded: false,
        offsetTop: 6,
        scrollTop: 0,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBeUndefined();
    expect(
      preservedSidebarScrollTop({
        expanded: true,
        offsetTop: 6,
        scrollTop: 6,
        scrollHeight: 12,
        viewportHeight: 5,
      }),
    ).toBeUndefined();
  });

  it("does not show other-session rows by default when current session has no executions", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "ses_other_running",
        title: "Other session running",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_running",
        messageID: "msg_other_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
    ]);

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
    });

    expect(snapshot.showingOtherSessions).toBe(false);
    expect(snapshot.visibleChildren).toEqual([]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(0);
  });

  it("uses projected visibility while preserving scoped real-row metadata", () => {
    // Given: a proxy precedes its running real execution and a recent done row.
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const proxy = child({
      id: "tool:proxy",
      source: "tool",
      targetSessionID: "ses_real",
      messageID: "msg_1",
      title: "Preferred",
      agentName: "preferred-agent",
      startedAt: "2026-04-30T10:10:00.000Z",
    });
    const real = child({
      id: "ses_real",
      targetSessionID: "ses_real",
      messageID: "msg_1",
      title: "Generated",
      startedAt: "2026-04-30T10:10:00.000Z",
    });
    const done = child({
      id: "ses_done",
      targetSessionID: "ses_done",
      messageID: "msg_1",
      status: "done",
      color: "green",
      endedAt: "2026-04-30T10:19:00.000Z",
      updatedAt: "2026-04-30T10:19:00.000Z",
    });

    // When: the parent-scoped snapshot is resolved.
    const snapshot = resolveTuiSubagentSnapshot({
      state: stateWith([proxy, real, done]),
      sessionID: "ses_parent",
      nowMs,
    });

    // Then: visibility follows projection while scoped rows retain real metadata.
    expect(
      snapshot.visibleChildren.map(({ id, title, agentName }) => ({
        id,
        title,
        agentName,
      })),
    ).toEqual([
      { id: "ses_real", title: "Generated", agentName: undefined },
      { id: "ses_done", title: "Child work", agentName: undefined },
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 1, done: 1, error: 0 });
    expect(snapshot.totalExecuted).toBe(2);
    expect(snapshot.showingOtherSessions).toBe(false);
  });

  it("keeps retained terminal counters separate from default visible rows", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const retainedDone = Array.from({ length: 6 }, (_, index) =>
      child({
        id: `ses_done_${index}`,
        title: `Retained done ${index}`,
        source: "session",
        targetSessionID: `ses_done_${index}`,
        messageID: `msg_done_${index}`,
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    );
    const retainedErrors = Array.from({ length: 7 }, (_, index) =>
      child({
        id: `ses_error_${index}`,
        title: `Retained error ${index}`,
        source: "session",
        targetSessionID: `ses_error_${index}`,
        messageID: `msg_error_${index}`,
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    );
    const state = stateWith([
      child({
        id: "ses_running",
        title: "Active child",
        source: "session",
        targetSessionID: "ses_running",
        messageID: "msg_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
      ...retainedDone,
      ...retainedErrors,
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
    });
    const historySnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });

    expect(defaultSnapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_running",
    ]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 1,
      done: 6,
      error: 7,
    });
    expect(defaultSnapshot.totalExecuted).toBe(14);
    expect(historySnapshot.visibleChildren).toHaveLength(14);
    expect(historySnapshot.visibleChildren.map((item) => item.id)).toEqual(
      expect.arrayContaining(["ses_done_0", "ses_error_0"]),
    );
    expect(historySnapshot.visibleCounts).toEqual(defaultSnapshot.visibleCounts);
    expect(historySnapshot.totalExecuted).toBe(defaultSnapshot.totalExecuted);
  });

  it("indexes every mounted visible row without imposing the eight-row height limit", () => {
    const children = Array.from({ length: 12 }, (_, index) =>
      child({
        id: `ses_${index}`,
        targetSessionID: `ses_${index}`,
        startedAt: `2026-04-30T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const snapshot = resolveTuiSubagentSnapshot({
      state: stateWith(children),
      sessionID: "ses_parent",
    });

    expect(snapshot.visibleChildren).toHaveLength(12);
    expect(snapshot.visibleChildrenByID.size).toBe(12);
    expect(
      snapshot.visibleChildren.map((entry) =>
        snapshot.visibleChildrenByID.get(entry.id),
      ),
    ).toEqual(snapshot.visibleChildren);
  });

  it("keeps rows and counters in the current session scope when current history is hidden", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "ses_current_done_old",
        title: "Current retained done",
        source: "session",
        parentID: "ses_current",
        targetSessionID: "ses_current_done_old",
        messageID: "msg_current_done",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
      child({
        id: "ses_current_error_old",
        title: "Current retained error",
        source: "session",
        parentID: "ses_current",
        targetSessionID: "ses_current_error_old",
        messageID: "msg_current_error",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:03:00.000Z",
        updatedAt: "2026-04-30T10:03:00.000Z",
      }),
      child({
        id: "ses_other_running",
        title: "Other session running",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_running",
        messageID: "msg_other_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
    });
    const historySnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
      showCompletedHistory: true,
    });

    expect(defaultSnapshot.showingOtherSessions).toBe(false);
    expect(defaultSnapshot.visibleChildren.map((item) => item.id)).toEqual([]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 0,
      done: 1,
      error: 1,
    });
    expect(defaultSnapshot.totalExecuted).toBe(2);
    expect(historySnapshot.visibleChildren).toHaveLength(2);
    expect(historySnapshot.visibleChildren.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "ses_current_error_old",
        "ses_current_done_old",
      ]),
    );
    expect(historySnapshot.visibleCounts).toEqual(defaultSnapshot.visibleCounts);
    expect(historySnapshot.totalExecuted).toBe(defaultSnapshot.totalExecuted);
  });

  it("does not fall back to other-session rows when current session has no retained executions", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "tool_current_wrapper",
        title: "Current wrapper only",
        source: "tool",
        parentID: "ses_current",
        targetSessionID: undefined,
        messageID: "msg_current_wrapper",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:19:00.000Z",
        updatedAt: "2026-04-30T10:19:00.000Z",
      }),
      child({
        id: "ses_other_running",
        title: "Other session running",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_running",
        messageID: "msg_other_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
      child({
        id: "ses_other_done_old",
        title: "Other retained done",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_done_old",
        messageID: "msg_other_done",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
    });

    expect(defaultSnapshot.showingOtherSessions).toBe(false);
    expect(defaultSnapshot.visibleChildren.map((item) => item.id)).toEqual([]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 0,
      done: 0,
      error: 0,
    });
    expect(defaultSnapshot.totalExecuted).toBe(0);
  });

  it("keeps the sidebar snapshot scoped to the current session", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "tool_current_wrapper",
        title: "Current wrapper only",
        source: "tool",
        parentID: "ses_current",
        targetSessionID: undefined,
        messageID: "msg_current_wrapper",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:19:00.000Z",
        updatedAt: "2026-04-30T10:19:00.000Z",
      }),
      child({
        id: "ses_other_running",
        title: "Other session running",
        source: "session",
        parentID: "ses_other",
        targetSessionID: "ses_other_running",
        messageID: "msg_other_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
    ]);

    const snapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
    });

    expect(snapshot.showingOtherSessions).toBe(false);
    expect(snapshot.visibleChildren.map((item) => item.id)).toEqual([]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(0);
  });

  it("computes sidebar total from counted current-session execution identities", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith(
      [
        child({
          id: "tool_current_proxy",
          title: "task",
          source: "tool",
          parentID: "ses_current",
          targetSessionID: "ses_current_child",
          messageID: "msg_current",
          status: "done",
          color: "green",
          endedAt: "2026-04-30T10:19:00.000Z",
          updatedAt: "2026-04-30T10:19:00.000Z",
        }),
        child({
          id: "ses_current_child",
          title: "Current child",
          source: "session",
          parentID: "ses_current",
          targetSessionID: "ses_current_child",
          messageID: "msg_current",
          status: "done",
          color: "green",
          endedAt: "2026-04-30T10:19:00.000Z",
          updatedAt: "2026-04-30T10:19:00.000Z",
        }),
        child({
          id: "ses_current_uncounted",
          title: "Uncounted current child",
          source: "session",
          parentID: "ses_current",
          targetSessionID: "ses_current_uncounted",
          messageID: "msg_uncounted",
          status: "done",
          color: "green",
          endedAt: "2026-04-30T10:19:00.000Z",
          updatedAt: "2026-04-30T10:19:00.000Z",
        }),
        child({
          id: "ses_other_child",
          title: "Other child",
          source: "session",
          parentID: "ses_other",
          targetSessionID: "ses_other_child",
          status: "done",
          color: "green",
          endedAt: "2026-04-30T10:19:00.000Z",
          updatedAt: "2026-04-30T10:19:00.000Z",
        }),
      ],
      ["ses_current_child", "ses_other_child"],
    );

    const snapshot = resolveSidebarSubagentSnapshot({
      state,
      sessionID: "ses_current",
      nowMs,
      showCompletedHistory: true,
    });

    expect(snapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_current_child",
      "ses_current_uncounted",
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 2, error: 0 });
    expect(snapshot.totalExecuted).toBe(1);
  });

  it("resolves sidebar and home snapshots from classified real executions only", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "tool:delegate-wrapper",
        title: "Delegation: inspect counters",
        source: "tool",
        toolName: "delegate",
        targetSessionID: undefined,
        messageID: "msg_delegate",
      }),
      child({
        id: "tool:task-proxy",
        title: "task",
        source: "tool",
        toolName: "task",
        targetSessionID: "ses_real_running",
        messageID: "msg_real_running",
      }),
      child({
        id: "ses_real_running",
        title: "Delegation: real child still counts",
        source: "session",
        targetSessionID: "ses_real_running",
        messageID: "msg_real_running",
        status: "running",
      }),
      child({
        id: "ses_real_done_old",
        title: "Completed child",
        source: "session",
        targetSessionID: "ses_real_done_old",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    ]);

    const sidebar = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
    });
    const home = resolveTuiSubagentSnapshot({ state, nowMs });

    expect(sidebar.visibleChildren.map((item) => item.id)).toEqual([
      "ses_real_running",
    ]);
    expect(sidebar.visibleCounts).toEqual({ running: 1, done: 1, error: 0 });
    expect(sidebar.totalExecuted).toBe(2);
    expect(home.visibleChildren.map((item) => item.id)).toEqual([
      "ses_real_running",
    ]);
    expect(home.visibleCounts).toEqual(sidebar.visibleCounts);
    expect(home.totalExecuted).toBe(2);
  });

  it("shows completed real history without adding wrappers to visible counts", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "tool:old-wrapper",
        title: "delegate",
        source: "tool",
        toolName: "delegate",
        targetSessionID: undefined,
      }),
      child({
        id: "ses_real_done_old",
        title: "Delegation: old but real",
        source: "session",
        targetSessionID: "ses_real_done_old",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    ]);

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });

    expect(snapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_real_done_old",
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 1, error: 0 });
    expect(snapshot.totalExecuted).toBe(1);
  });

  it("keeps stale errors historical while retaining status counters", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "ses_real_running",
        title: "Active child",
        source: "session",
        targetSessionID: "ses_real_running",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
      child({
        id: "ses_real_error_old",
        title: "Old failed child",
        source: "session",
        targetSessionID: "ses_real_error_old",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:02:00.000Z",
        updatedAt: "2026-04-30T10:02:00.000Z",
      }),
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
    });
    const historySnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });

    expect(defaultSnapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_real_running",
    ]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 1,
      done: 0,
      error: 1,
    });
    expect(defaultSnapshot.totalExecuted).toBe(2);
    expect(historySnapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_real_running",
      "ses_real_error_old",
    ]);
    expect(historySnapshot.visibleCounts).toEqual({
      running: 1,
      done: 0,
      error: 1,
    });
    expect(historySnapshot.totalExecuted).toBe(2);
  });

  it("excludes recent unrelated errors from active rows while retaining counters", () => {
    const nowMs = Date.parse("2026-04-30T10:20:00.000Z");
    const state = stateWith([
      child({
        id: "ses_real_running",
        title: "Active child",
        source: "session",
        targetSessionID: "ses_real_running",
        messageID: "msg_active",
        status: "running",
        startedAt: "2026-04-30T10:10:00.000Z",
        updatedAt: "2026-04-30T10:10:00.000Z",
      }),
      child({
        id: "ses_real_error_active",
        title: "Active failed child",
        source: "session",
        targetSessionID: "ses_real_error_active",
        messageID: "msg_active",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:19:00.000Z",
        updatedAt: "2026-04-30T10:19:00.000Z",
      }),
      child({
        id: "ses_real_error_recent_unrelated",
        title: "Recent unrelated failed child",
        source: "session",
        targetSessionID: "ses_real_error_recent_unrelated",
        messageID: "msg_unrelated",
        status: "error",
        color: "red",
        endedAt: "2026-04-30T10:19:30.000Z",
        updatedAt: "2026-04-30T10:19:30.000Z",
      }),
    ]);

    const defaultSnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
    });
    const historySnapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs,
      showCompletedHistory: true,
    });

    expect(defaultSnapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_real_running",
      "ses_real_error_active",
    ]);
    expect(defaultSnapshot.visibleCounts).toEqual({
      running: 1,
      done: 0,
      error: 2,
    });
    expect(defaultSnapshot.totalExecuted).toBe(3);
    expect(historySnapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_real_running",
      "ses_real_error_active",
      "ses_real_error_recent_unrelated",
    ]);
    expect(historySnapshot.visibleCounts).toEqual({
      running: 1,
      done: 0,
      error: 2,
    });
    expect(historySnapshot.totalExecuted).toBe(3);
  });

  it("backfills hydrated targets only when the real session match is unique", () => {
    const ambiguous = stateWith([
      child({
        id: "tool:ambiguous",
        source: "tool",
        toolName: "task",
        targetSessionID: undefined,
        messageID: "msg_wrapper",
      }),
      child({ id: "ses_first", targetSessionID: "ses_first" }),
      child({ id: "ses_second", targetSessionID: "ses_second" }),
    ]);

    expect(backfillHydratedTargetSessionIDs(ambiguous, "ses_parent")).toBe(
      false,
    );
    expect(ambiguous.children["tool:ambiguous"]?.targetSessionID).toBeUndefined();

    const matched = child({
      id: "tool:matched",
      source: "tool",
      toolName: "task",
      targetSessionID: undefined,
      messageID: "msg_real",
    });
    const untouched = child({
      id: "ses_first",
      targetSessionID: "ses_first",
      messageID: "msg_other",
    });
    const unique = stateWith([
      matched,
      untouched,
      child({
        id: "ses_second",
        targetSessionID: "ses_second",
        messageID: "msg_real",
      }),
    ]);

    expect(backfillHydratedTargetSessionIDs(unique, "ses_parent")).toBe(true);
    expect(unique.children["tool:matched"]).not.toBe(matched);
    expect(unique.children["tool:matched"]?.targetSessionID).toBe("ses_second");
    expect(matched.targetSessionID).toBeUndefined();
    expect(unique.children["ses_first"]).toBe(untouched);
  });

  it("uses the transaction index without rescanning all staged children", () => {
    // Given: a staged state whose global child enumeration is observable.
    const synthetic = child({
      id: "subtask:indexed",
      source: "subtask",
      targetSessionID: undefined,
      messageID: "msg_real",
    });
    const real = child({
      id: "ses_real",
      targetSessionID: "ses_real",
      messageID: "msg_real",
    });
    const state = stateWith([synthetic, real]);
    const index = createHydrationTransactionIndex(Object.values(state.children));
    let globalScans = 0;
    state.children = new Proxy(state.children, {
      ownKeys(target) {
        globalScans += 1;
        return Reflect.ownKeys(target);
      },
    });

    // When: indexed backfill resolves the parent's synthetic rows.
    const changed = backfillHydratedTargetSessionIDs(
      state,
      "ses_parent",
      index,
    );

    // Then: the index supplies both iteration and target resolution.
    expect(changed).toBe(true);
    expect(state.children[synthetic.id]?.targetSessionID).toBe(real.id);
    expect(globalScans).toBe(0);
  });
});

describe("hydratePreviousSubagents", () => {
  it.each([
    { phase: "before", expectedCalls: 0 },
    { phase: "tree", expectedCalls: 1 },
    { phase: "messages", expectedCalls: 9 },
    { phase: "publication", expectedCalls: 201 },
  ])("stops startup hydration after $phase cancellation", async ({ phase, expectedCalls }) => {
    let active = phase !== "before";
    const sessions = Array.from({ length: 200 }, (_, index) => ({
      id: `ses_cancel_${index}`, parentID: "ses_root", title: "Child",
    }));
    const messages = vi.fn(async ({ sessionID }: { sessionID: string }) => {
      if (phase === "messages" && sessionID !== "ses_root") active = false;
      if (phase === "publication" && sessionID === "ses_cancel_199") active = false;
      return { data: [] };
    });
    const children = vi.fn(async ({ sessionID }: { sessionID: string }) => {
      if (phase === "tree") active = false;
      return { data: sessionID === "ses_root" ? sessions : [] };
    });
    const api = {
      state: { path: { directory: "/repo" } },
      client: { session: {
        children, messages,
        status: vi.fn(async () => ({ data: Object.fromEntries(
          sessions.map((session) => [session.id, { type: "busy" }]),
        ) })),
      } },
    } as unknown as TuiPluginApi;
    let current = stateWith([]);
    const publish = vi.fn((update: (state: StatuslineState) => StatuslineState) => {
      current = update(current);
    });
    expect(await hydratePreviousSubagents(api, "ses_root", publish, () => active)).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(messages).toHaveBeenCalledTimes(expectedCalls);
    if (phase === "tree") expect(children).toHaveBeenCalledOnce();
    if (phase === "before") expect(children).not.toHaveBeenCalled();
    expect(Object.keys(current.children)).toEqual([]);
  });

  it("prioritizes ten active histories while bounding 200 startup requests to eight", async () => {
    const sessions = Array.from({ length: 200 }, (_, index) => ({
      id: `ses_startup_${index}`, parentID: "ses_root", title: "Child",
    }));
    let inFlight = 0;
    let peak = 0;
    let metadataInFlight = 0;
    let metadataPeak = 0;
    const children = vi.fn(async ({ sessionID }: { sessionID: string }) => {
      metadataInFlight += 1;
      metadataPeak = Math.max(metadataPeak, metadataInFlight);
      await Promise.resolve();
      metadataInFlight -= 1;
      return { data: sessionID === "ses_root" ? sessions : [] };
    });
    const requestedIDs: string[] = [];
    const messages = vi.fn(async ({ sessionID }: { sessionID: string }) => {
      requestedIDs.push(sessionID);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { data: [] };
    });
    const api = {
      state: { path: { directory: "/repo" } },
      client: { session: {
        children,
        messages,
        status: vi.fn(async () => ({ data: Object.fromEntries(
          sessions.map((session, index) => [session.id, { type: index >= 190 ? "busy" : "idle" }]),
        ) })),
      } },
    } as unknown as TuiPluginApi;
    let current = stateWith([]);
    expect(await hydratePreviousSubagents(api, "ses_root", (update) => {
      current = update(current);
    })).toBe(true);
    expect(messages).toHaveBeenCalledTimes(201);
    expect(requestedIDs).toEqual([
      "ses_root",
      ...sessions.slice(190).map((session) => session.id),
      ...sessions.slice(0, 190).map((session) => session.id),
    ]);
    expect(peak).toBeLessThanOrEqual(8);
    expect(metadataPeak).toBe(8);
    expect(children).toHaveBeenCalledTimes(201);
    expect(Object.keys(current.children)).toHaveLength(200);
    expect(Object.values(current.children).filter((item) => item.status === "running")).toHaveLength(10);
  });

  const hydratedChild = {
    id: "ses_child",
    parentID: "ses_parent",
    title: "Hydrated child",
    agent: "sdd-propose",
    time: { created: "2026-04-30T10:00:00.000Z" },
  };

  it("skips child-session stubs with no status, messages, or parent evidence", async () => {
    const state = await hydrateState({
      children: [hydratedChild],
      childMessages: { ses_child: [] },
      statuses: {},
    });

    expect(state.children).not.toHaveProperty("ses_child");
    expect(
      resolveTuiSubagentSnapshot({ state, sessionID: "ses_parent" })
        .visibleCounts,
    ).toEqual({ running: 0, done: 0, error: 0 });
  });

  it("hydrates a child with explicit running status", async () => {
    const state = await hydrateState({
      children: [hydratedChild],
      childMessages: { ses_child: [] },
      statuses: { ses_child: { status: "running" } },
    });

    expect(state.children["ses_child"]?.status).toBe("running");
    expect(
      resolveTuiSubagentSnapshot({ state, sessionID: "ses_parent" })
        .visibleCounts,
    ).toEqual({ running: 1, done: 0, error: 0 });
  });

  it("replays sessions before parts so synthetic evidence sees staged sessions", async () => {
    // Given: one real child and a parent subtask part without an explicit target.
    const state = await hydrateState({
      children: [{
        id: "ses_child",
        parentID: "ses_parent",
        title: "Child",
      }],
      statuses: { ses_child: { type: "busy" } },
      parentMessages: [{
        info: { id: "msg", role: "assistant" },
        parts: [{
          id: "part",
          type: "subtask",
          sessionID: "ses_parent",
          messageID: "msg",
          description: "Child",
        }],
      }],
    });

    // When: hydration publishes the completed staged replay.
    // Then: the later synthetic row resolves against the earlier real insertion.
    expect(state.children["subtask:part"]?.targetSessionID).toBe("ses_child");
    expect(state.children.ses_child?.status).toBe("running");
    expect(state.totalExecuted).toBe(1);
  });

  it("keeps global replay scans constant as parent part count grows", async () => {
    // Given: otherwise identical hydration runs with one and twelve parts.
    const hydrateWithPartCount = async (partCount: number): Promise<number> => {
      const valuesSpy = vi.spyOn(Object, "values");
      const callsBefore = valuesSpy.mock.calls.length;
      await hydrateState({
        children: [],
        parentMessages: [{
          info: { id: "msg_parent", role: "assistant" },
          parts: Array.from({ length: partCount }, (_, index) => ({
            id: `part_${index}`,
            type: "subtask",
            sessionID: "ses_parent",
            messageID: "msg_parent",
            description: `Child ${index}`,
          })),
        }],
      });
      const calls = valuesSpy.mock.calls.length - callsBefore;
      valuesSpy.mockRestore();
      return calls;
    };

    // When: replay size grows beyond the former viewport-sized batch.
    const singlePartScans = await hydrateWithPartCount(1);
    const twelvePartScans = await hydrateWithPartCount(12);

    // Then: transaction-local indexes prevent per-part global scans.
    expect(twelvePartScans).toBe(singlePartScans);
  });

  it("does not rematch a terminal replayed subtask as running", async () => {
    // Given: a completed assistant message with subtask and task-tool evidence.
    const state = await hydrateState({
      children: [],
      parentMessages: [{
        info: {
          id: "msg_parent",
          role: "assistant",
          time: { completed: "2099-04-30T12:00:00.000Z" },
        },
        parts: [
          {
            id: "part_subtask",
            type: "subtask",
            sessionID: "ses_parent",
            messageID: "msg_parent",
            description: "Completed child",
          },
          {
            id: "part_tool",
            type: "tool",
            tool: "task",
            sessionID: "ses_parent",
            messageID: "msg_parent",
            state: {
              status: "completed",
              input: { description: "Completed child" },
              metadata: { sessionId: "ses_external" },
            },
          },
        ],
      }],
    });

    // Then: the shared index observes the subtask's direct terminal transition.
    expect(Object.keys(state.children).sort()).toEqual([
      "subtask:part_subtask",
      "tool:part_tool",
    ]);
    expect(state.children["subtask:part_subtask"]?.status).toBe("done");
    expect(
      state.children["subtask:part_subtask"]?.targetSessionID,
    ).toBeUndefined();
    expect(state.children["tool:part_tool"]?.targetSessionID).toBe(
      "ses_external",
    );
  });

  it("hydrates a grandchild session", async () => {
    // Given: the root's direct child and that child's direct child are running.
    // When: the previous subagents are hydrated from root session A.
    const state = await hydrateState({
      sessionID: "ses_A",
      children: [],
      childrenByParent: {
        ses_A: [
          {
            id: "ses_B",
            parentID: "ses_A",
            title: "Child B",
            time: { created: "2026-04-30T10:00:00.000Z" },
          },
        ],
        ses_B: [
          {
            id: "ses_C",
            parentID: "ses_B",
            title: "Grandchild C",
            time: { created: "2026-04-30T10:01:00.000Z" },
          },
        ],
      },
      childMessages: { ses_B: [], ses_C: [] },
      statuses: {
        ses_B: { status: "running" },
        ses_C: { status: "running" },
      },
    });

    // Then: both real executions retain their immediate parent and count.
    expect(Object.keys(state.children)).toEqual(["ses_B", "ses_C"]);
    expect(state.children.ses_B).toEqual(
      expect.objectContaining({
        id: "ses_B",
        parentID: "ses_A",
        status: "running",
        targetSessionID: "ses_B",
      }),
    );
    expect(state.children.ses_C).toEqual(
      expect.objectContaining({
        id: "ses_C",
        parentID: "ses_B",
        status: "running",
        targetSessionID: "ses_C",
      }),
    );
    expect(state.countedChildIDs).toEqual({ ses_B: true, ses_C: true });
    expect(state.totalExecuted).toBe(2);
  });

  it("terminates and de-duplicates duplicate and cyclic direct-child responses", async () => {
    // Given: each response contains direct children only, with duplicate rows
    // and a cycle back to the already visited root session.
    const result = await hydrateStateWithResult({
      sessionID: "ses_A",
      children: [],
      childrenByParent: {
        ses_A: [
          { ...hydratedChild, id: "ses_B", parentID: "ses_A" },
          { ...hydratedChild, id: "ses_B", parentID: "ses_A" },
        ],
        ses_B: [
          { ...hydratedChild, id: "ses_C", parentID: "ses_B" },
          { ...hydratedChild, id: "ses_C", parentID: "ses_B" },
        ],
        ses_C: [
          { ...hydratedChild, id: "ses_A", parentID: "ses_C" },
        ],
      },
      childMessages: { ses_B: [], ses_C: [] },
      statuses: {
        ses_B: { status: "running" },
        ses_C: { status: "running" },
      },
    });

    // When: hydration traverses the cyclic direct-child responses.
    // Then: completion is bounded to the unique descendants and their lineage.
    expect(result.hydrated).toBe(true);
    expect(result.childrenSessionIDs).toHaveLength(3);
    expect(result.childrenSessionIDs).toEqual(["ses_A", "ses_B", "ses_C"]);
    const state = result.state;
    const stateIDs = Object.keys(state.children);
    expect(new Set(stateIDs).size).toBe(stateIDs.length);
    expect(stateIDs).toEqual(["ses_B", "ses_C"]);
    expect(
      Object.values(state.children).map(({ id, parentID }) => ({ id, parentID })),
    ).toEqual([
      { id: "ses_B", parentID: "ses_A" },
      { id: "ses_C", parentID: "ses_B" },
    ]);
    expect(state.countedChildIDs).toEqual({ ses_B: true, ses_C: true });
    expect(state.totalExecuted).toBe(2);

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_A",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(
      snapshot.visibleChildren.map(({ id, parentID }) => ({ id, parentID })),
    ).toEqual([
      { id: "ses_B", parentID: "ses_A" },
      { id: "ses_C", parentID: "ses_B" },
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 2, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(2);
  });

  it("preserves stable ancestor-first projection order for nested branches", async () => {
    // Given: direct-child responses arrive in reverse ID order for two branches.
    const state = await hydrateState({
      sessionID: "ses_A",
      children: [],
      childrenByParent: {
        ses_A: [
          { ...hydratedChild, id: "ses_D", parentID: "ses_A" },
          { ...hydratedChild, id: "ses_B", parentID: "ses_A" },
        ],
        ses_B: [
          { ...hydratedChild, id: "ses_C", parentID: "ses_B" },
        ],
        ses_D: [
          { ...hydratedChild, id: "ses_E", parentID: "ses_D" },
        ],
      },
      childMessages: { ses_B: [], ses_C: [], ses_D: [], ses_E: [] },
      statuses: {
        ses_B: { status: "running" },
        ses_C: { status: "running" },
        ses_D: { status: "running" },
        ses_E: { status: "running" },
      },
    });

    // When: hydration discovers the branches and projects the ancestor snapshot.
    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_A",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    // Then: each ancestor precedes its descendant, independent of response order.
    expect(
      snapshot.visibleChildren.map(({ id, parentID }) => ({ id, parentID })),
    ).toEqual([
      { id: "ses_B", parentID: "ses_A" },
      { id: "ses_C", parentID: "ses_B" },
      { id: "ses_D", parentID: "ses_A" },
      { id: "ses_E", parentID: "ses_D" },
    ]);
    expect(state.countedChildIDs).toEqual({
      ses_B: true,
      ses_C: true,
      ses_D: true,
      ses_E: true,
    });
    expect(state.totalExecuted).toBe(4);
    expect(snapshot.visibleCounts).toEqual({ running: 4, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(4);
  });

  it("returns failure after a descendant lookup while retaining earlier hydrated descendants", async () => {
    // Given: the descendant tree is discovered through direct-only calls, but
    // the deepest session's children lookup fails after B and C are found.
    const result = await hydrateStateWithResult({
      sessionID: "ses_A",
      children: [],
      childrenByParent: {
        ses_A: [
          { ...hydratedChild, id: "ses_B", parentID: "ses_A" },
        ],
        ses_B: [
          { ...hydratedChild, id: "ses_C", parentID: "ses_B" },
        ],
      },
      failChildrenFor: ["ses_C"],
      childMessages: { ses_B: [], ses_C: [] },
      statuses: {
        ses_B: { status: "running" },
        ses_C: { status: "running" },
      },
    });

    // When: hydration completes with a descendant children failure.
    // Then: it reports failure without discarding data fetched before it.
    expect(result.hydrated).toBe(false);
    expect(result.childrenSessionIDs).toEqual(["ses_A", "ses_B", "ses_C"]);
    expect(Object.keys(result.state.children)).toEqual(["ses_B", "ses_C"]);
    expect(
      Object.values(result.state.children).map(({ id, parentID }) => ({
        id,
        parentID,
      })),
    ).toEqual([
      { id: "ses_B", parentID: "ses_A" },
      { id: "ses_C", parentID: "ses_B" },
    ]);
    expect(result.state.countedChildIDs).toEqual({
      ses_B: true,
      ses_C: true,
    });
    expect(result.state.totalExecuted).toBe(2);

    const snapshot = resolveTuiSubagentSnapshot({
      state: result.state,
      sessionID: "ses_A",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(snapshot.visibleChildren.map((child) => child.id)).toEqual([
      "ses_B",
      "ses_C",
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 2, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(2);
  });

  it("hydrates model metadata from direct and enveloped child messages", async () => {
    const state = await hydrateState({
      children: [
        hydratedChild,
        { ...hydratedChild, id: "ses_envelope" },
      ],
      childMessages: {
        ses_child: [{
          sessionID: "ses_child",
          role: "assistant",
          providerID: "openai",
          modelID: "gpt-5.6",
          variant: "high",
          time: { created: 10 },
        }],
        ses_envelope: [{
          info: {
            sessionID: "ses_envelope",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet",
            variant: "max",
            time: { created: 20 },
          },
          parts: [],
        }],
      },
      statuses: {
        ses_child: { status: "running" },
        ses_envelope: { status: "running" },
      },
    });

    expect(state.children.ses_child.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6",
      variant: "high",
    });
    expect(state.children.ses_envelope.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
      variant: "max",
    });
  });

  it("hydrates terminal done and error evidence", async () => {
    const errorAt = new Date().toISOString();
    const state = await hydrateState({
      children: [
        { ...hydratedChild, id: "ses_done", title: "Done child" },
        { ...hydratedChild, id: "ses_error", title: "Error child" },
      ],
      childMessages: {
        ses_done: [],
        ses_error: [
          {
            info: {
              role: "assistant",
              error: { detail: "Unsupported content type" },
              time: { updated: errorAt },
            },
            parts: [],
          },
        ],
      },
      statuses: { ses_done: { status: "idle" } },
    });

    expect(state.children["ses_done"]?.status).toBe("done");
    expect(state.children["ses_error"]?.status).toBe("error");
    expect(
      resolveTuiSubagentSnapshot({ state, sessionID: "ses_parent" })
        .visibleCounts,
    ).toEqual({ running: 0, done: 1, error: 1 });
  });

  it("hydrates a child linked by parent tool evidence", async () => {
    const state = await hydrateState({
      children: [hydratedChild],
      parentMessages: [
        {
          id: "msg_parent",
          info: { id: "msg_parent", role: "assistant" },
          parts: [
            {
              id: "part_task",
              type: "tool",
              tool: "task",
              sessionID: "ses_parent",
              state: {
                status: "running",
                metadata: { sessionId: "ses_child" },
                input: {
                  description: "Hydrated child",
                  subagent_type: "sdd-propose",
                },
              },
            },
          ],
        },
      ],
      childMessages: { ses_child: [] },
      statuses: {},
    });

    expect(state.children["ses_child"]?.status).toBe("running");
    expect(state.children["tool:part_task"]?.targetSessionID).toBe(
      "ses_child",
    );
  });

  it("hydrates terminal parent task evidence onto the real child session", async () => {
    const completedAt = new Date().toISOString();
    const state = await hydrateState({
      children: [hydratedChild],
      parentMessages: [
        {
          id: "msg_parent",
          info: {
            id: "msg_parent",
            role: "assistant",
            time: { completed: completedAt },
          },
          parts: [
            {
              id: "part_task",
              type: "tool",
              tool: "task",
              sessionID: "ses_parent",
              state: {
                status: "completed",
                metadata: { sessionId: "ses_child" },
                input: {
                  description: "Hydrated child",
                  subagent_type: "sdd-propose",
                },
              },
            },
          ],
        },
      ],
      childMessages: { ses_child: [] },
      statuses: {},
    });

    expect(state.children["ses_child"]?.status).toBe("done");
    expect(state.children["tool:part_task"]?.status).toBe("done");
  });

  it("does not hydrate an empty child from an incidental parent text mention", async () => {
    const state = await hydrateState({
      children: [hydratedChild],
      parentMessages: [
        {
          id: "msg_parent",
          info: { id: "msg_parent", role: "assistant" },
          parts: [
            {
              id: "part_text",
              type: "text",
              text: "The log mentioned ses_child, but no task metadata linked it.",
            },
            {
              id: "part_task",
              type: "tool",
              tool: "task",
              sessionID: "ses_parent",
              state: {
                status: "completed",
                output: "unstructured log mentioned ses_child",
                input: { description: "Unrelated task" },
              },
            },
          ],
        },
      ],
      childMessages: { ses_child: [] },
      statuses: {},
    });

    expect(state.children).not.toHaveProperty("ses_child");
  });
});

describe("probeRunningEvidence", () => {
  it("lets client status nested error evidence override direct done status", async () => {
    const api = {
      state: {
        session: {
          status: vi.fn(() => "done"),
        },
      },
      client: {
        session: {
          status: vi.fn(async () => ({
            data: {
              ses_child: {
                status: "idle",
                info: { error: { detail: "Unsupported content type" } },
              },
            },
          })),
          messages: vi.fn(async () => ({ data: [] })),
        },
      },
    } as unknown as TuiPluginApi;

    const evidence = await probeRunningEvidence({
      api,
      targetSessionID: "ses_child",
      directory: "/repo",
      candidateAgeMs: 60_000,
      nowMs: Date.now(),
    });

    expect(evidence.status).toBe("error");
    expect(api.client.session.status).toHaveBeenCalledOnce();
    expect(api.client.session.messages).not.toHaveBeenCalled();
  });
});

describe("persisted parent-message reconciliation", () => {
  it("discovers a cached busy child through polling without remote histories", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T12:30:00Z"));
    let dispose: (() => void) | undefined;
    const handlers = new Map<string, (event: unknown) => void>();
    const api = {
      state: {
        path: { directory: "/repo" }, provider: [],
        session: {
          get: vi.fn((id: string) => id === "ses_new" ? { id, parentID: "ses_parent", title: "New child" } : undefined),
          status: vi.fn(() => ({ type: "busy" })),
          messages: vi.fn((_sessionID: string) => []),
        },
        part: vi.fn(() => []),
      },
      route: { current: { name: "session", params: { sessionID: "ses_root" } } },
      kv: { get<Value>(_key: string, fallback: Value): Value { return fallback; }, set: vi.fn() },
      client: { session: {
        children: vi.fn(async () => ({ data: [] })),
        messages: vi.fn(async () => ({ data: [] })),
        status: vi.fn(async () => ({ data: { ses_new: { type: "busy" } } })),
      } },
      event: { on: vi.fn((name: string, handler: (event: unknown) => void) => {
        handlers.set(name, handler); return vi.fn();
      }) },
      lifecycle: { onDispose: vi.fn((callback: () => void) => { dispose = callback; }) },
      slots: { register: vi.fn() },
      ui: { dialog: { clear: vi.fn() }, toast: vi.fn(), Prompt: vi.fn(), Slot: vi.fn() },
    };
    try {
      await tuiPlugin.tui(api as never, undefined, {} as never);
      await vi.advanceTimersByTimeAsync(0);
      const statusBaseline = api.client.session.status.mock.calls.length;
      const historiesBaseline = api.client.session.messages.mock.calls.length;
      handlers.get("session.created")?.({ type: "session.created", properties: {
        info: { id: "ses_parent", parentID: "ses_root", title: "Parent" },
      } });
      handlers.get("session.idle")?.({ type: "session.idle", properties: { sessionID: "ses_parent" } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.state.session.get).toHaveBeenCalledExactlyOnceWith("ses_new");
      expect(api.client.session.status).toHaveBeenCalledTimes(statusBaseline + 1);
      api.state.session.messages.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.client.session.status).toHaveBeenCalledTimes(statusBaseline + 2);
      expect(api.state.session.messages).toHaveBeenCalledWith("ses_new");
      expect(api.state.session.messages).not.toHaveBeenCalledWith("ses_parent");
      expect(api.state.session.get).toHaveBeenCalledExactlyOnceWith("ses_new");
      expect(api.client.session.messages).toHaveBeenCalledTimes(historiesBaseline);
    } finally {
      dispose?.();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["queued-event", "dispose"])("shares parent analysis and rejects late recovery after %s", async (interruption) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-04-30T12:30:00.000Z");
    let dispose: (() => void) | undefined;

    try {
      const handlers = new Map<string, (event: unknown) => void>();
      let analysisRuns = 0;
      const storedMessages = [
        {
          info: {
            role: "assistant",
            parentID: "msg_a",
            time: { completed: "2026-04-30T12:00:00.000Z" },
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                metadata: { sessionId: "ses_a" },
              },
            },
          ],
        },
        {
          info: {
            role: "assistant",
            parentID: "msg_b",
            time: { completed: "2026-04-30T12:01:00.000Z" },
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "error",
                metadata: { sessionId: "ses_b" },
              },
            },
          ],
        },
      ];
      const parentMessages = new Proxy(storedMessages, {
        get(target, property, receiver) {
          if (property === Symbol.iterator) {
            return () => {
              analysisRuns += 1;
              return target[Symbol.iterator]();
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const messages = vi.fn(async () => ({ data: parentMessages }));
      const api = {
        state: {
          path: { directory: "/repo" },
          provider: [],
          session: {
            status: vi.fn(),
            messages: vi.fn(() => []),
          },
          part: vi.fn(() => []),
        },
        route: { current: { name: "home", params: {} } },
        kv: {
          get<Value>(_key: string, fallback: Value): Value {
            return fallback;
          },
          set: vi.fn(),
        },
        client: {
          session: {
            messages,
            status: vi.fn(async () => ({ data: {} })),
          },
        },
        event: {
          on: vi.fn((name: string, handler: (event: unknown) => void) => {
            handlers.set(name, handler);
            return vi.fn();
          }),
        },
        lifecycle: {
          onDispose: vi.fn((callback: () => void) => {
            dispose = callback;
          }),
        },
        slots: { register: vi.fn() },
        ui: {
          dialog: { clear: vi.fn() },
          toast: vi.fn(),
          Prompt: vi.fn(),
          Slot: vi.fn(),
        },
      };

      await tuiPlugin.tui(api as never, undefined, {} as never);
      const applyPart = handlers.get("message.part.updated");
      expect(applyPart).toBeTypeOf("function");
      let descriptionsRead = 0;
      applyPart?.({
        type: "message.part.updated",
        properties: {
          sessionID: "ses_parent",
          info: {
            id: "msg_a",
            role: "assistant",
            time: { created: "2026-04-30T10:00:00.000Z" },
          },
          part: {
            id: "a",
            type: "subtask",
            sessionID: "ses_parent",
            messageID: "msg_a",
            get description() { descriptionsRead += 1; return "A task"; },
          },
        },
      });
      applyPart?.({
        type: "message.part.updated",
        properties: {
          sessionID: "ses_parent",
          info: {
            id: "msg_b",
            role: "assistant",
            time: { created: "2026-04-30T10:01:00.000Z" },
          },
          part: {
            id: "b",
            type: "subtask",
            sessionID: "ses_parent",
            messageID: "msg_b",
            description: "B task",
          },
        },
      });

      expect(descriptionsRead).toBe(0);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(descriptionsRead).toBe(0);
      expect(messages).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(501);
      expect(descriptionsRead).toBeGreaterThan(0);

      expect(messages).toHaveBeenCalledOnce();
      expect(analysisRuns).toBe(1);
      const created = handlers.get("session.created");
      for (let index = 0; index < 10; index += 1) {
        created?.({ type: "session.created", properties: { info: {
          id: `ses_poll_${index}`, parentID: "ses_parent", title: "Polling child",
        } } });
      }
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.client.session.status).toHaveBeenCalledOnce();
      const idle = handlers.get("session.idle");
      for (let index = 0; index < 10; index += 1) {
        idle?.({ type: "session.idle", properties: { sessionID: `ses_poll_${index}` } });
      }
      api.client.session.status.mockResolvedValue({ data: { ses_poll_0: { type: "busy" } } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.client.session.status).toHaveBeenCalledTimes(2);
      api.state.session.messages.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.client.session.status).toHaveBeenCalledTimes(3);
      expect(api.state.session.messages).toHaveBeenCalledWith("ses_poll_0");
      expect(api.state.session.messages).not.toHaveBeenCalledWith("ses_poll_1");
      let lateRecoveryReads = 0;
      const lateStatus = { data: {
        get ses_poll_1() { lateRecoveryReads += 1; return { type: "busy" }; },
      } };
      let releaseStatus: (response: typeof lateStatus) => void = () => {
        throw new Error("status request did not start");
      };
      api.client.session.status.mockImplementationOnce(() => new Promise<typeof lateStatus>((resolve) => {
        releaseStatus = resolve;
      }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.client.session.status).toHaveBeenCalledTimes(4);
      if (interruption === "queued-event") {
        idle?.({ type: "session.idle", properties: { sessionID: "ses_poll_1" } });
      } else {
        dispose?.();
      }
      releaseStatus(lateStatus);
      await vi.advanceTimersByTimeAsync(0);
      expect(lateRecoveryReads).toBe(0);
      let disposedReads = 0;
      applyPart?.({ get type() { disposedReads += 1; return "message.part.updated"; } });
      dispose?.();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(disposedReads).toBe(0);
    } finally {
      dispose?.();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("TUI subagent hydration", () => {
  async function hydrateWith(input: {
    initialChildren?: ChildSessionState[];
    children: unknown[];
    childrenBySession?: Record<string, unknown[]>;
    statuses?: Record<string, unknown>;
    messagesBySession?: Record<string, unknown[]>;
    failMessagesFor?: string[];
    failStatus?: boolean;
  }): Promise<StatuslineState> {
    let state = stateWith(input.initialChildren ?? []);
    const directory = await mkdtemp(join(tmpdir(), "subagent-tui-hydrate-"));
    const api = {
      state: {
        path: { directory },
        session: {
          status: vi.fn(),
          messages: vi.fn(),
        },
        part: vi.fn(),
      },
      client: {
        session: {
          children: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
            data: input.childrenBySession?.[sessionID] ?? input.children,
          })),
          messages: vi.fn(async ({ sessionID }: { sessionID: string }) => {
            if (input.failMessagesFor?.includes(sessionID)) {
              throw new Error(`failed to read messages for ${sessionID}`);
            }
            return { data: input.messagesBySession?.[sessionID] ?? [] };
          }),
          status: vi.fn(async () => {
            if (input.failStatus) {
              throw new Error("failed to read statuses");
            }
            return { data: input.statuses ?? {} };
          }),
        },
      },
    };

    await hydratePreviousSubagents(
      api as never,
      "ses_parent",
      (fn: (prev: StatuslineState) => StatuslineState) => {
        state = fn(state);
      },
    );

    return state;
  }

  it("does not leave visible running rows from historical children without status evidence", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_historical",
          parentID: "ses_parent",
          title: "Historical child",
          source: "session",
          targetSessionID: "ses_child_historical",
          status: "running",
        }),
      ],
      children: [
        {
          id: "ses_child_historical",
          parentID: "ses_parent",
          title: "Historical child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      statuses: {},
    });

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(Object.keys(state.children)).toEqual([]);
    expect(snapshot.visibleChildren).toEqual([]);
    expect(snapshot.visibleCounts).toEqual({ running: 0, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(0);
  });

  it("preserves an existing running row when child-message evidence fails", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          source: "session",
          targetSessionID: "ses_child_running",
          status: "running",
        }),
      ],
      children: [
        {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      statuses: {},
      failMessagesFor: ["ses_child_running"],
    });

    expect(state.children.ses_child_running?.status).toBe("running");
  });

  it("preserves an existing running row when parent-message evidence fails", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          source: "session",
          targetSessionID: "ses_child_running",
          status: "running",
        }),
      ],
      children: [
        {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      statuses: {},
      failMessagesFor: ["ses_parent"],
    });

    expect(state.children.ses_child_running?.status).toBe("running");
  });

  it("preserves an existing current-session running row when status hydration fails", async () => {
    const state = await hydrateWith({
      initialChildren: [
        child({
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          source: "session",
          targetSessionID: "ses_child_running",
          status: "running",
        }),
      ],
      children: [
        {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      messagesBySession: {
        ses_parent: [],
        ses_child_running: [],
      },
      failStatus: true,
    });

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(state.children.ses_child_running?.status).toBe("running");
    expect(snapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_child_running",
    ]);
  });

  it("hydrates a visible running row when child status is explicitly busy", async () => {
    const state = await hydrateWith({
      children: [
        {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Running child",
          time: { created: "2026-04-30T10:00:00.000Z" },
        },
      ],
      statuses: { ses_child_running: { status: "busy" } },
    });

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(snapshot.visibleChildren.map((item) => item.id)).toEqual([
      "ses_child_running",
    ]);
    expect(snapshot.visibleCounts).toEqual({ running: 1, done: 0, error: 0 });
    expect(snapshot.totalExecuted).toBe(1);
  });

  it("hydrates terminal child statuses without leaving them running", async () => {
    const updatedAt = new Date().toISOString();
    const state = await hydrateWith({
      children: [
        {
          id: "ses_child_done",
          parentID: "ses_parent",
          title: "Done child",
          time: {
            created: "2026-04-30T10:00:00.000Z",
            updated: updatedAt,
          },
        },
      ],
      statuses: { ses_child_done: { status: "idle" } },
    });

    expect(state.children.ses_child_done?.status).toBe("done");
    expect(state.children.ses_child_done?.endedAt).toBe(updatedAt);
  });

  it("hydrates the complete descendant subtree for an ancestor snapshot", async () => {
    const state = await hydrateWith({
      children: [],
      childrenBySession: {
        ses_parent: [
          {
            id: "ses_child",
            parentID: "ses_parent",
            title: "Child work",
            time: { created: "2026-04-30T10:00:00.000Z" },
          },
        ],
        ses_child: [
          {
            id: "ses_grandchild",
            parentID: "ses_child",
            title: "Grandchild work",
            time: { created: "2026-04-30T10:00:00.000Z" },
          },
        ],
      },
      statuses: {
        ses_child: { status: "busy" },
        ses_grandchild: { status: "busy" },
      },
    });

    const snapshot = resolveTuiSubagentSnapshot({
      state,
      sessionID: "ses_parent",
      nowMs: Date.parse("2026-04-30T10:20:00.000Z"),
    });

    expect(
      snapshot.visibleChildren.map(({ id, parentID }) => ({ id, parentID })),
    ).toEqual([
      { id: "ses_child", parentID: "ses_parent" },
      { id: "ses_grandchild", parentID: "ses_child" },
    ]);
    expect(snapshot.totalExecuted).toBe(2);
  });
});

describe("registerSubagentCommands", () => {
  it("registers both keymap and legacy commands when both APIs are available", () => {
    const keymapDispose = vi.fn();
    const legacyDispose = vi.fn();
    const registerLayer = vi.fn(() => keymapDispose);
    const commandRegister = vi.fn(() => legacyDispose);
    const toggleSection = vi.fn();
    const focusSidebarList = vi.fn();
    const toggleCompletedHistory = vi.fn();

    const result = registerSubagentCommands({
      api: {
        keymap: { registerLayer },
        command: { register: commandRegister },
      },
      sectionEnabled: () => true,
      toggleSection,
      focusSidebarList,
      toggleCompletedHistory,
    });

    expect(commandRegister).toHaveBeenCalledOnce();
    expect(registerLayer).toHaveBeenCalledOnce();
    expect(registerLayer).toHaveBeenCalledWith({
      commands: [
        expect.objectContaining({
          name: "subagent-statusline.toggle-sidebar-section",
          title: expect.stringContaining("Subagents"),
          run: expect.any(Function),
        }),
        expect.objectContaining({
          name: "subagent-statusline.focus-sidebar-list",
          title: "Subagents: Focus sidebar list",
          run: expect.any(Function),
        }),
        expect.objectContaining({
          name: "subagent-statusline.toggle-completed-history",
          title: "Subagents: Toggle completed history",
          run: expect.any(Function),
        }),
      ],
      bindings: [
        {
          key: "alt+b",
          cmd: "subagent-statusline.focus-sidebar-list",
        },
      ],
    });

    const layer = registerLayer.mock.calls[0]?.[0];
    layer?.commands?.[0]?.run();
    layer?.commands?.[1]?.run();
    layer?.commands?.[2]?.run();

    const legacyCommands = commandRegister.mock.calls[0]?.[0]?.();
    legacyCommands?.[0]?.onSelect?.();
    legacyCommands?.[1]?.onSelect?.();
    legacyCommands?.[2]?.onSelect?.();

    expect(toggleSection).toHaveBeenNthCalledWith(1, false);
    expect(toggleSection).toHaveBeenNthCalledWith(2, false);
    expect(focusSidebarList).toHaveBeenCalledTimes(2);
    expect(toggleCompletedHistory).toHaveBeenCalledTimes(2);

    expect(legacyCommands).toEqual([
      expect.objectContaining({
        value: "subagent-statusline.toggle-sidebar-section",
        description: "Toggle the entire subagent sidebar section",
        category: "Subagents",
      }),
      expect.objectContaining({
        title: "Subagents: Focus sidebar list",
        value: "subagent-statusline.focus-sidebar-list",
        keybind: "alt+b",
      }),
      expect.objectContaining({
        title: "Subagents: Toggle completed history",
        value: "subagent-statusline.toggle-completed-history",
        description: expect.stringContaining("Shortcut: c"),
      }),
    ]);

    result();
    expect(keymapDispose).toHaveBeenCalledOnce();
    expect(legacyDispose).toHaveBeenCalledOnce();

    result();
    expect(keymapDispose).toHaveBeenCalledOnce();
    expect(legacyDispose).toHaveBeenCalledOnce();
  });

  it("registers only keymap when legacy API is unavailable", () => {
    const dispose = vi.fn();
    const registerLayer = vi.fn(() => dispose);
    const toggleSection = vi.fn();
    const focusSidebarList = vi.fn();
    const toggleCompletedHistory = vi.fn();

    const result = registerSubagentCommands({
      api: {
        keymap: { registerLayer },
      },
      sectionEnabled: () => true,
      toggleSection,
      focusSidebarList,
      toggleCompletedHistory,
    });

    expect(registerLayer).toHaveBeenCalledOnce();
    const layer = registerLayer.mock.calls[0]?.[0];
    expect(layer?.bindings).toEqual([
      {
        key: "alt+b",
        cmd: "subagent-statusline.focus-sidebar-list",
      },
    ]);

    layer?.commands?.[0]?.run();
    layer?.commands?.[1]?.run();
    layer?.commands?.[2]?.run();
    expect(toggleSection).toHaveBeenCalledWith(false);
    expect(focusSidebarList).toHaveBeenCalledOnce();
    expect(toggleCompletedHistory).toHaveBeenCalledOnce();

    result();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("falls back to the legacy command API when keymap is unavailable", () => {
    const dispose = vi.fn();
    const register = vi.fn(() => dispose);
    const toggleSection = vi.fn();
    const focusSidebarList = vi.fn();
    const toggleCompletedHistory = vi.fn();

    const result = registerSubagentCommands({
      api: { command: { register } },
      sectionEnabled: () => false,
      toggleSection,
      focusSidebarList,
      toggleCompletedHistory,
    });

    expect(register).toHaveBeenCalledOnce();
    const legacyCommands = register.mock.calls[0]?.[0]?.();
    expect(legacyCommands).toEqual([
      expect.objectContaining({
        title: "Subagents: Enable sidebar section",
        value: "subagent-statusline.toggle-sidebar-section",
      }),
      expect.objectContaining({
        value: "subagent-statusline.focus-sidebar-list",
        keybind: "alt+b",
      }),
      expect.objectContaining({
        value: "subagent-statusline.toggle-completed-history",
        description: expect.stringContaining("sidebar list is focused"),
      }),
    ]);

    legacyCommands?.[0]?.onSelect?.();
    legacyCommands?.[1]?.onSelect?.();
    legacyCommands?.[2]?.onSelect?.();
    expect(toggleSection).toHaveBeenCalledWith(true);
    expect(focusSidebarList).toHaveBeenCalledOnce();
    expect(toggleCompletedHistory).toHaveBeenCalledOnce();

    result();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns a safe no-op disposer when neither API is available", () => {
    const result = registerSubagentCommands({
      api: {},
      sectionEnabled: () => false,
      toggleSection: vi.fn(),
      focusSidebarList: vi.fn(),
      toggleCompletedHistory: vi.fn(),
    });

    expect(() => result()).not.toThrow();
    expect(() => result()).not.toThrow();
  });

  it("disposes all created registrations even if one dispose throws", () => {
    const keymapDispose = vi.fn(() => {
      throw new Error("keymap dispose failed");
    });
    const legacyDispose = vi.fn();
    const registerLayer = vi.fn(() => keymapDispose);
    const register = vi.fn(() => legacyDispose);

    const result = registerSubagentCommands({
      api: {
        keymap: { registerLayer },
        command: { register },
      },
      sectionEnabled: () => false,
      toggleSection: vi.fn(),
      focusSidebarList: vi.fn(),
      toggleCompletedHistory: vi.fn(),
    });

    expect(() => result()).not.toThrow();
    expect(keymapDispose).toHaveBeenCalledOnce();
    expect(legacyDispose).toHaveBeenCalledOnce();

    result();
    expect(keymapDispose).toHaveBeenCalledOnce();
    expect(legacyDispose).toHaveBeenCalledOnce();
  });
});

describe("resolveSidebarReturnFocusAction", () => {
  const pendingSidebarRefocus = {
    parentSessionID: "parent",
    childSessionID: "child",
    childRowID: "row-1",
  };

  it("returns focus-prompt for remembered child -> parent return", () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus,
        previousRouteSessionID: "child",
        routeSessionID: "parent",
      }),
    ).toBe("focus-prompt");
  });

  it("returns focus-prompt while preserving showCompletedHistory", () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus: {
          ...pendingSidebarRefocus,
          showCompletedHistory: true,
        },
        previousRouteSessionID: "child",
        routeSessionID: "parent",
      }),
    ).toBe("focus-prompt");
  });

  it("returns clear-pending when route leaves remembered child path", () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus,
        previousRouteSessionID: "child",
        routeSessionID: "another",
      }),
    ).toBe("clear-pending");
  });

  it("returns none for unrelated transitions while still on child", () => {
    expect(
      resolveSidebarReturnFocusAction({
        pendingSidebarRefocus,
        previousRouteSessionID: "parent",
        routeSessionID: "child",
      }),
    ).toBe("none");
  });

  it("returns none when no pending sidebar navigation exists", () => {
    expect(
      resolveSidebarReturnFocusAction({
        previousRouteSessionID: "child",
        routeSessionID: "parent",
      }),
    ).toBe("none");
  });
});

describe("shouldReleaseSidebarListFocus", () => {
  it("releases active list focus when the last running subagent completes", () => {
    expect(
      shouldReleaseSidebarListFocus({
        previousRunningCount: 1,
        runningCount: 0,
        listFocusModeActive: true,
      }),
    ).toBe(true);
  });

  it("preserves list focus without a running-to-terminal transition", () => {
    expect(
      shouldReleaseSidebarListFocus({
        previousRunningCount: 0,
        runningCount: 0,
        listFocusModeActive: true,
      }),
    ).toBe(false);
    expect(
      shouldReleaseSidebarListFocus({
        previousRunningCount: 1,
        runningCount: 0,
        listFocusModeActive: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSiblingSidebarRefocus", () => {
  const pendingSidebarRefocus = {
    parentSessionID: "parent",
    childSessionID: "child-a",
    childRowID: "row-a",
  };

  it("returns updated child row ID when navigating to a sibling subagent", () => {
    expect(
      resolveSiblingSidebarRefocus({
        pendingSidebarRefocus,
        routeSessionID: "child-b",
        children: {
          "row-a": { id: "row-a", parentID: "parent", targetSessionID: "child-a" },
          "row-b": { id: "row-b", parentID: "parent", targetSessionID: "child-b" },
        },
      }),
    ).toEqual({ childSessionID: "child-b", childRowID: "row-b" });
  });

  it("returns undefined when route returns to parent", () => {
    expect(
      resolveSiblingSidebarRefocus({
        pendingSidebarRefocus,
        routeSessionID: "parent",
        children: {
          "row-a": { id: "row-a", parentID: "parent", targetSessionID: "child-a" },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when route stays on recorded child", () => {
    expect(
      resolveSiblingSidebarRefocus({
        pendingSidebarRefocus,
        routeSessionID: "child-a",
        children: {
          "row-a": { id: "row-a", parentID: "parent", targetSessionID: "child-a" },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when target session is not a sibling", () => {
    expect(
      resolveSiblingSidebarRefocus({
        pendingSidebarRefocus,
        routeSessionID: "other-child",
        children: {
          "row-a": { id: "row-a", parentID: "parent", targetSessionID: "child-a" },
          "row-other": { id: "row-other", parentID: "other-parent", targetSessionID: "other-child" },
        },
      }),
    ).toBeUndefined();
  });
});

describe("focusPromptWithDeferredRetry", () => {
  it("retries once when prompt focus is initially unavailable", () => {
    const queue: Array<() => void> = [];
    const schedule = (callback: () => void): void => {
      queue.push(callback);
    };
    let hasPromptRef = false;
    const focus = vi.fn(() => {
      if (!hasPromptRef) {
        hasPromptRef = true;
        return false;
      }
      return true;
    });

    focusPromptWithDeferredRetry(focus, schedule);
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
