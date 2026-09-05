import { describe, expect, it } from "vitest";
import {
  classifySubagentWorkItem,
  correlateSubagentWorkItems,
  isRealSessionID,
  isTrustedTargetSessionID,
  mergeProxyMetadataWithRealExecution,
  resolveCorrelatedExecutionID,
  trustedTargetSessionID,
  type CorrelatedSubagentExecution,
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

function legacyCorrelateForTest<T extends SubagentClassifiableWorkItem>(
  items: readonly T[],
): CorrelatedSubagentExecution<T>[] {
  const realItems = items.filter(
    (entry) => classifySubagentWorkItem(entry).kind === "real-execution",
  );
  const executions = new Map<string, CorrelatedSubagentExecution<T>>();

  for (const real of realItems) {
    const classification = classifySubagentWorkItem(real);
    if (
      classification.kind !== "real-execution" ||
      executions.has(classification.executionID)
    ) {
      continue;
    }
    executions.set(classification.executionID, {
      executionID: classification.executionID,
      real,
      proxies: [],
    });
  }

  for (const proxy of items) {
    if (classifySubagentWorkItem(proxy).kind === "real-execution") continue;
    const executionID = resolveCorrelatedExecutionID(proxy, realItems);
    if (executionID) executions.get(executionID)?.proxies.push(proxy);
  }

  return [...executions.values()];
}

function correlationPropertyReads(size: number): number {
  let reads = 0;
  const observe = <T extends SubagentClassifiableWorkItem>(value: T): T =>
    new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === "string") reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
  const values = [
    ...Array.from({ length: size }, (_, index) =>
      observe(
        item({
          id: `ses_${index}`,
          targetSessionID: `ses_${index}`,
          parentID: `parent_${index % 7}`,
          messageID: `msg_${index}`,
        }),
      ),
    ),
    ...Array.from({ length: size }, (_, index) =>
      observe(
        item({
          id: `tool:${index}`,
          source: "tool",
          targetSessionID: index % 3 === 0 ? undefined : `ses_${index}`,
          parentID: `parent_${index % 7}`,
          messageID: `msg_${index}`,
        }),
      ),
    ),
  ];

  correlateSubagentWorkItems(values);
  return reads;
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

  it("matches the legacy resolver over a deterministic mixed corpus", () => {
    const corpus = Array.from({ length: 40 }, (_, index) =>
      index % 3 === 0
        ? item({
            id: `ses_${index}`,
            targetSessionID: `ses_${index}`,
            parentID: `parent_${index % 4}`,
            messageID: `msg_${index % 5}`,
          })
        : item({
            id: `tool:${index}`,
            source: "tool",
            targetSessionID:
              index % 2 === 0 ? `ses_${index - 2}` : undefined,
            parentID: `parent_${index % 4}`,
            messageID: index % 5 === 0 ? undefined : `msg_${index % 5}`,
          }),
    );

    const correlated = correlateSubagentWorkItems(corpus);

    expect(correlated).toEqual(legacyCorrelateForTest(corpus));
  });

  it("preserves first-real, proxy order, and both fail-closed ambiguity modes", () => {
    const first = item({
      id: "ses_a_first",
      targetSessionID: "ses_a",
      messageID: "msg_a",
    });
    const duplicate = item({
      id: "ses_a_second",
      targetSessionID: "ses_a",
      messageID: "msg_a",
    });
    const other = item({
      id: "ses_b",
      targetSessionID: "ses_b",
      messageID: "msg_a",
    });
    const targeted = item({
      id: "tool:target",
      source: "tool",
      targetSessionID: "ses_a",
    });
    const sharedAmbiguous = item({
      id: "tool:shared",
      source: "tool",
      targetSessionID: undefined,
      messageID: "msg_a",
    });
    const parentAmbiguous = item({
      id: "tool:parent",
      source: "tool",
      targetSessionID: undefined,
      messageID: undefined,
    });
    const missingTrusted = item({
      id: "tool:missing",
      source: "tool",
      targetSessionID: "ses_missing",
      messageID: "msg_a",
    });

    const correlated = correlateSubagentWorkItems([
      targeted,
      sharedAmbiguous,
      first,
      duplicate,
      other,
      parentAmbiguous,
      missingTrusted,
    ]);

    expect(correlated).toEqual([
      { executionID: "ses_a", real: first, proxies: [targeted] },
      { executionID: "ses_b", real: other, proxies: [] },
    ]);
  });

  it("has sub-quadratic property-read growth when real and proxy counts double", () => {
    const smallReads = correlationPropertyReads(32);

    const largeReads = correlationPropertyReads(64);

    expect(largeReads).toBeLessThan(smallReads * 3);
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
});
