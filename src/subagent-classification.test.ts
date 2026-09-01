import { describe, expect, it } from "vitest";
import {
  classifySubagentWorkItem,
  correlateSubagentWorkItems,
  isRealSessionID,
  isTrustedTargetSessionID,
  mergeProxyMetadataWithRealExecution,
  resolveCorrelatedExecutionID,
  trustedTargetSessionID,
  type SubagentClassifiableWorkItem,
} from "./subagent-classification.js";
import type { ChildSessionState } from "./state.js";

function item(
  overrides: Partial<ChildSessionState> = {},
): ChildSessionState {
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
    tokens: { total: 42, contextPercent: 12.5 },
    ...overrides,
  };
}

describe("subagent classification", () => {
  it("classifies real Delegation-titled sessions by semantic fields", () => {
    expect(isRealSessionID("ses_child")).toBe(true);
    expect(isRealSessionID("tool:delegate")).toBe(false);

    expect(
      classifySubagentWorkItem(
        item({ title: "Delegation: inspect history counters" }),
      ),
    ).toEqual({
      kind: "real-execution",
      executionID: "ses_child",
      targetSessionID: "ses_child",
    });
  });

  it("classifies targetless delegate, task, and subtask rows as wrappers", () => {
    const wrappers: SubagentClassifiableWorkItem[] = [
      item({
        id: "tool:delegate_call",
        source: "tool",
        toolName: "delegate",
        title: "Delegation: scout",
        targetSessionID: undefined,
      }),
      item({
        id: "tool:task_call",
        source: "tool",
        toolName: "task",
        title: "task",
        targetSessionID: undefined,
      }),
      item({
        id: "subtask:part_1",
        source: "subtask",
        title: "Investigate bug",
        targetSessionID: undefined,
      }),
    ];

    expect(wrappers.map(classifySubagentWorkItem)).toEqual([
      { kind: "invocation-wrapper" },
      { kind: "invocation-wrapper" },
      { kind: "invocation-wrapper" },
    ]);
  });

  it("classifies trusted target session rows as execution proxies", () => {
    const proxy = item({
      id: "tool:task_call",
      source: "tool",
      toolName: "task",
      targetSessionID: "ses_child",
    });

    expect(isTrustedTargetSessionID(proxy.targetSessionID)).toBe(true);
    expect(trustedTargetSessionID(proxy)).toBe("ses_child");
    expect(classifySubagentWorkItem(proxy)).toEqual({
      kind: "execution-proxy",
      executionID: "ses_child",
      targetSessionID: "ses_child",
    });
  });

  it("correlates proxies using trusted target and shared message evidence", () => {
    const real = item({ id: "ses_real", targetSessionID: "ses_real" });
    const targetedProxy = item({
      id: "tool:targeted",
      source: "tool",
      targetSessionID: "ses_real",
    });
    const messageWrapper = item({
      id: "subtask:message_match",
      source: "subtask",
      targetSessionID: undefined,
      messageID: "msg_1",
    });

    expect(resolveCorrelatedExecutionID(targetedProxy, [real])).toBe(
      "ses_real",
    );
    expect(resolveCorrelatedExecutionID(messageWrapper, [real])).toBe(
      "ses_real",
    );
    expect(
      correlateSubagentWorkItems([targetedProxy, messageWrapper, real]),
    ).toEqual([
      {
        executionID: "ses_real",
        real,
        proxies: [targetedProxy, messageWrapper],
      },
    ]);
  });

  it("fails closed for ambiguous same-parent wrappers", () => {
    const wrapper = item({
      id: "tool:ambiguous",
      source: "tool",
      targetSessionID: undefined,
      messageID: undefined,
    });
    const firstReal = item({
      id: "ses_first",
      targetSessionID: "ses_first",
      messageID: "msg_a",
    });
    const secondReal = item({
      id: "ses_second",
      targetSessionID: "ses_second",
      messageID: "msg_b",
    });

    expect(
      resolveCorrelatedExecutionID(wrapper, [firstReal, secondReal]),
    ).toBeUndefined();
    expect(
      correlateSubagentWorkItems([wrapper, firstReal, secondReal]),
    ).toEqual([
      { executionID: "ses_first", real: firstReal, proxies: [] },
      { executionID: "ses_second", real: secondReal, proxies: [] },
    ]);
  });

  it("fails closed when a trusted proxy target is missing from real candidates", () => {
    const proxy = item({
      id: "tool:missing-target",
      source: "tool",
      targetSessionID: "ses_missing",
      messageID: "msg_shared",
    });
    const unrelatedReal = item({
      id: "ses_unrelated",
      targetSessionID: "ses_unrelated",
      messageID: "msg_shared",
    });
    const sameParentOnlyProxy = item({
      id: "tool:missing-target-same-parent",
      source: "tool",
      targetSessionID: "ses_other_missing",
      messageID: undefined,
    });
    const sameParentReal = item({
      id: "ses_same_parent",
      targetSessionID: "ses_same_parent",
      messageID: "msg_other",
    });

    expect(resolveCorrelatedExecutionID(proxy, [unrelatedReal])).toBeUndefined();
    expect(correlateSubagentWorkItems([proxy, unrelatedReal])).toEqual([
      { executionID: "ses_unrelated", real: unrelatedReal, proxies: [] },
    ]);
    expect(
      resolveCorrelatedExecutionID(sameParentOnlyProxy, [sameParentReal]),
    ).toBeUndefined();
    expect(
      correlateSubagentWorkItems([sameParentOnlyProxy, sameParentReal]),
    ).toEqual([
      { executionID: "ses_same_parent", real: sameParentReal, proxies: [] },
    ]);
  });

  it("characterizes correlation precedence: trusted target > shared message > unique same parent", () => {
    const trustedReal = item({ id: "ses_trusted", targetSessionID: "ses_trusted", messageID: "msg_trusted", parentID: "ses_trusted" });
    const proxy = item({ id: "tool:proxy", source: "tool", targetSessionID: "ses_trusted", messageID: "msg_trusted" });
    const messageOnly = item({ id: "subtask:msg", source: "subtask", parentID: "ses_trusted", messageID: "msg_trusted", targetSessionID: undefined });
    const sameParentOnly = item({ id: "subtask:parent", source: "subtask", parentID: "ses_trusted", messageID: "msg_other", targetSessionID: undefined });

    // Trusted target takes precedence over message match.
    expect(resolveCorrelatedExecutionID(proxy, [trustedReal])).toBe("ses_trusted");
    // When no trusted target exists, message match is used (messageOnly has msg_trusted matching trustedReal's msg_trusted when parent matches).
    expect(resolveCorrelatedExecutionID(messageOnly, [item({ id: "ses_other", targetSessionID: "ses_other", parentID: "ses_trusted", messageID: "msg_trusted" })])).toBe("ses_other");
    // Same-parent unique execution is last resort; with a single real session it resolves.
    expect(resolveCorrelatedExecutionID(sameParentOnly, [trustedReal])).toBe("ses_trusted");
  });

  it("characterizes ambiguous same-parent with multiple real executions remains fail-closed", () => {
    const wrapper = item({ id: "tool:ambig", source: "tool", targetSessionID: undefined, messageID: undefined, parentID: "ses_parent" });
    const first = item({ id: "ses_first", targetSessionID: "ses_first", parentID: "ses_parent", messageID: "msg_1" });
    const second = item({ id: "ses_second", targetSessionID: "ses_second", parentID: "ses_parent", messageID: "msg_1" });
    const third = item({ id: "ses_third", targetSessionID: "ses_third", parentID: "ses_parent", messageID: "msg_1" });

    expect(resolveCorrelatedExecutionID(wrapper, [first, second, third])).toBeUndefined();
    expect(correlateSubagentWorkItems([wrapper, first, second, third])).toHaveLength(3);
  });

  it("characterizes proxy metadata precedence: proxy title/summary overrides real, status/color preserved", () => {
    const real = item({ id: "ses_real", title: "Real title", status: "done", color: "green", endedAt: "2026-04-30T10:05:00.000Z", elapsedMs: 300000 });
    const proxy = item({ id: "tool:proxy", source: "tool", targetSessionID: "ses_real", title: "Proxy title", summary: "Proxy summary", agentName: "proxy-agent", status: "running", color: "yellow", tokens: { total: 999 } });

    const merged = mergeProxyMetadataWithRealExecution(real, proxy);
    expect(merged.title).toBe("Proxy title");
    expect(merged.summary).toBe("Proxy summary");
    expect(merged.agentName).toBe("proxy-agent");
    expect(merged.status).toBe("done");
    expect(merged.color).toBe("green");
    expect(merged.id).toBe("ses_real");
    expect(merged.source).toBe("session");
    expect(merged.tokens?.total).toBe(42);
  });

  it("merges safe proxy display metadata without replacing real execution state", () => {
    const real = item({
      id: "ses_real",
      targetSessionID: "ses_real",
      title: "Delegation: generated title",
      status: "done",
      color: "green",
      endedAt: "2026-04-30T10:05:00.000Z",
      elapsedMs: 300000,
    });
    const proxy = item({
      id: "tool:proxy",
      source: "tool",
      title: "Review classifier behavior",
      summary: "Check wrapper semantics",
      agentName: "reviewer",
      targetSessionID: "ses_real",
      status: "running",
      color: "yellow",
      tokens: { total: 999 },
    });

    expect(mergeProxyMetadataWithRealExecution(real, proxy)).toMatchObject({
      id: "ses_real",
      source: "session",
      targetSessionID: "ses_real",
      title: "Review classifier behavior",
      summary: "Check wrapper semantics",
      agentName: "reviewer",
      status: "done",
      color: "green",
      endedAt: "2026-04-30T10:05:00.000Z",
      elapsedMs: 300000,
      tokens: { total: 42, contextPercent: 12.5 },
    });
  });

  // Parity/property-style fixtures for indexed correlation (Task 2).
  describe("indexed correlation parity fixtures", () => {
    it("trusted target resolves via index when present among real candidates", () => {
      const real = item({ id: "ses_trusted", targetSessionID: "ses_trusted" });
      const proxy = item({ id: "tool:proxy", source: "tool", targetSessionID: "ses_trusted" });
      expect(correlateSubagentWorkItems([proxy, real])).toEqual([
        { executionID: "ses_trusted", real, proxies: [proxy] },
      ]);
    });

    it("supplied-but-missing trusted target remains fail-closed (missing target)", () => {
      const proxy = item({ id: "tool:missing", source: "tool", targetSessionID: "ses_absent" });
      expect(correlateSubagentWorkItems([proxy])).toEqual([]);
      expect(resolveCorrelatedExecutionID(proxy, [])).toBeUndefined();
    });

    it("unique message match resolves via parent/message composite index", () => {
      const real = item({ id: "ses_msg", parentID: "ses_p", messageID: "msg_unique", targetSessionID: "ses_msg" });
      const wrapper = item({ id: "subtask:msg", source: "subtask", parentID: "ses_p", messageID: "msg_unique", targetSessionID: undefined });
      expect(correlateSubagentWorkItems([wrapper, real])).toEqual([
        { executionID: "ses_msg", real, proxies: [wrapper] },
      ]);
    });

    it("unique same-parent resolves when only one real execution exists for that parent", () => {
      const real = item({ id: "ses_parent_only", parentID: "ses_p", messageID: "msg_a", targetSessionID: "ses_parent_only" });
      const wrapper = item({ id: "subtask:parent", source: "subtask", parentID: "ses_p", messageID: undefined, targetSessionID: undefined });
      expect(correlateSubagentWorkItems([wrapper, real])).toEqual([
        { executionID: "ses_parent_only", real, proxies: [wrapper] },
      ]);
    });

    it("ambiguity with multiple real executions for same parent/message remains fail-closed", () => {
      const r1 = item({ id: "ses_r1", parentID: "ses_p", messageID: "msg_shared", targetSessionID: "ses_r1" });
      const r2 = item({ id: "ses_r2", parentID: "ses_p", messageID: "msg_shared", targetSessionID: "ses_r2" });
      const wrapper = item({ id: "subtask:ambig", source: "subtask", parentID: "ses_p", messageID: "msg_shared", targetSessionID: undefined });
      expect(correlateSubagentWorkItems([wrapper, r1, r2])).toHaveLength(2);
      expect(correlateSubagentWorkItems([wrapper, r1, r2]).map((e) => e.executionID)).toEqual(
        expect.arrayContaining(["ses_r1", "ses_r2"]),
      );
    });

    it("duplicate real IDs preserve first-real insertion order (first wins)", () => {
      const first = item({ id: "ses_dup", title: "First", targetSessionID: "ses_dup" });
      const second = item({ id: "ses_dup", title: "Second", targetSessionID: "ses_dup" });
      // First occurrence in input order wins (second appears first here, so second wins).
      const result = correlateSubagentWorkItems([second, first]);
      expect(result).toHaveLength(1);
      expect(result[0].real.title).toBe("Second");
      expect(result[0].executionID).toBe("ses_dup");
    });

    it("proxy input order is preserved in proxies array", () => {
      const real = item({ id: "ses_order", parentID: "ses_order", targetSessionID: "ses_order", messageID: "msg_order" });
      const p1 = item({ id: "tool:p1", source: "tool", targetSessionID: "ses_order" });
      const p2 = item({ id: "subtask:p2", source: "subtask", targetSessionID: undefined, parentID: "ses_order", messageID: "msg_order" });
      const result = correlateSubagentWorkItems([p1, real, p2]);
      expect(result[0].proxies).toEqual([p1, p2]);
    });

    it("metadata merge preserves canonical execution order and real status/color/timing", () => {
      const real = item({ id: "ses_meta", title: "Real", status: "done", color: "green", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T01:00:00.000Z", endedAt: "2026-01-01T02:00:00.000Z", elapsedMs: 7200000, tokens: { total: 10 }, model: { providerID: "m", modelID: "m1" } });
      const proxy = item({ id: "tool:proxy", source: "tool", targetSessionID: "ses_meta", title: "Proxy", agentName: "agent", status: "running", color: "yellow", tokens: { total: 99 } });
      const merged = mergeProxyMetadataWithRealExecution(real, proxy);
      expect(merged.id).toBe("ses_meta");
      expect(merged.source).toBe("session");
      expect(merged.title).toBe("Proxy");
      expect(merged.status).toBe("done");
      expect(merged.color).toBe("green");
      expect(merged.tokens?.total).toBe(10);
      expect(merged.model).toEqual({ providerID: "m", modelID: "m1" });
    });
  });
});
