import { describe, expect, it } from "vitest";

import type { ChildSessionState, StatuslineState } from "./state.js";
import {
  createHydrationTransactionIndex,
  createHydrationMerger,
  mergeHydratedState,
} from "./tui-hydration-index.js";

function row(
  id: string,
  parentID: string,
  messageID?: string,
): ChildSessionState {
  const isSession = id.startsWith("ses_");
  return {
    id,
    title: id,
    parentID,
    ...(messageID ? { messageID } : {}),
    source: isSession ? "session" : "subtask",
    ...(isSession ? { targetSessionID: id } : {}),
    status: "running",
    color: "yellow",
    startedAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:00:00.000Z",
  };
}

describe("hydration transaction index", () => {
  it("makes each insertion visible and fails closed after a tie", () => {
    const index = createHydrationTransactionIndex([]);
    const synthetic = row("subtask:x", "ses_parent", "msg");

    index.upsert(synthetic);
    index.upsert(row("ses_a", "ses_parent", "msg"));
    expect(index.resolveSyntheticTarget(synthetic)).toBe("ses_a");

    index.upsert(row("ses_b", "ses_parent", "msg"));
    expect(index.resolveSyntheticTarget(synthetic)).toBeUndefined();

    index.remove("ses_b");
    expect(index.resolveSyntheticTarget(synthetic)).toBe("ses_a");
  });

  it("removes stale memberships when an existing row is rekeyed", () => {
    const original = row("ses_child", "ses_old_parent", "msg_old");
    const replacement = row("ses_child", "ses_new_parent", "msg_new");
    const index = createHydrationTransactionIndex([original]);

    index.upsert(replacement);

    expect(index.get("ses_child")).toBe(replacement);
    expect(index.childrenOf("ses_old_parent")).toEqual([]);
    expect(
      index.resolveSyntheticTarget(
        row("subtask:old", "ses_old_parent", "msg_old"),
      ),
    ).toBeUndefined();
    expect(index.childrenOf("ses_new_parent")).toEqual([replacement]);
    expect(
      index.resolveSyntheticTarget(
        row("subtask:new", "ses_new_parent", "msg_new"),
      ),
    ).toBe("ses_child");
  });

  it("preserves row order on replacement and appends after removal", () => {
    const first = row("ses_first", "ses_parent", "msg_first");
    const second = row("ses_second", "ses_parent", "msg_second");
    const replacement = { ...first, title: "replacement" };
    const reinserted = { ...first, title: "reinserted" };
    const index = createHydrationTransactionIndex([first, second]);

    index.upsert(replacement);
    expect(index.childrenOf("ses_parent")).toEqual([replacement, second]);

    index.remove("ses_first");
    index.upsert(reinserted);
    expect(index.childrenOf("ses_parent")).toEqual([second, reinserted]);
  });

  it("prefers a unique message match and requires unique parent fallback", () => {
    const matching = row("ses_matching", "ses_parent", "msg_target");
    const sibling = row("ses_sibling", "ses_parent", "msg_other");
    const index = createHydrationTransactionIndex([matching, sibling]);

    expect(
      index.resolveSyntheticTarget(
        row("subtask:matched", "ses_parent", "msg_target"),
      ),
    ).toBe("ses_matching");
    expect(
      index.resolveSyntheticTarget(row("subtask:unmatched", "ses_parent")),
    ).toBeUndefined();

    index.remove("ses_sibling");
    expect(
      index.resolveSyntheticTarget(
        row("subtask:fallback", "ses_parent", "msg_missing"),
      ),
    ).toBe("ses_matching");
  });

  it("ignores synthetic rows as target evidence", () => {
    const synthetic = row("subtask:source", "ses_parent", "msg");
    const index = createHydrationTransactionIndex([synthetic]);

    expect(index.resolveSyntheticTarget(synthetic)).toBeUndefined();
    expect(index.childrenOf("ses_parent")).toEqual([synthetic]);
  });

  it("keeps separate hydration attempts isolated", () => {
    const child = row("ses_child", "ses_parent", "msg");
    const first = createHydrationTransactionIndex([child]);
    const second = createHydrationTransactionIndex([]);

    first.remove("ses_child");
    second.upsert(child);

    expect(first.get("ses_child")).toBeUndefined();
    expect(second.get("ses_child")).toBe(child);
  });
});

function makeState(
  children: ChildSessionState[],
  countedChildIDs: Record<string, true> = {},
  totalExecuted = 0,
): StatuslineState {
  return {
    children: Object.fromEntries(children.map((item) => [item.id, item])),
    countedChildIDs: { ...countedChildIDs },
    totalExecuted,
    updatedAt: "2026-04-30T10:00:00.000Z",
  };
}

const RECENT_TS = "2026-09-05T10:00:00.000Z";
const RECENT_TS_LATER = "2026-09-05T11:00:00.000Z";

describe("mergeHydratedState", () => {
  it("accepts successive owned updates while retaining live changes and deletions", () => {
    const merger = createHydrationMerger(makeState([]));
    const first = makeState([row("ses_owned", "ses_root"), row("ses_live", "ses_root"), row("ses_deleted", "ses_root")]);
    let current = merger.merge(makeState([]), first);
    const live = { ...current.children.ses_live!, title: "Live title", tokens: { total: 99 } };
    current = makeState([current.children.ses_owned!, live]);
    const alias = { ...row("subtask:new", "ses_root"), targetSessionID: "ses_owned" };
    const second = makeState([
      { ...first.children.ses_owned!, title: "Historical enrichment" },
      first.children.ses_live!, first.children.ses_deleted!, alias,
    ]);
    current = merger.merge(current, second);
    expect(current.children.ses_owned?.title).toBe("Historical enrichment");
    expect(current.children[alias.id]).toBeDefined();
    expect(current.children.ses_live?.title).toBe("Live title");
    expect(current.children.ses_deleted).toBeUndefined();
    current = merger.merge(current, second);
    expect(current.children.ses_live?.tokens).toEqual({ total: 99 });
    expect(current.children.ses_deleted).toBeUndefined();
    expect(current.totalExecuted).toBe(2);
  });

  it.each([false, true])("keeps newly hydrated aliases regardless of target-first ordering: %s", (targetFirst) => {
    const target = row("ses_target", "ses_root");
    const alias = { ...row("subtask:new", "ses_root"), targetSessionID: "ses_target" };
    const baseline = makeState([]);
    const current = makeState([]);
    const hydrated = makeState(targetFirst ? [target, alias] : [alias, target]);
    const merged = mergeHydratedState(baseline, current, hydrated);
    expect(merged.children[alias.id]?.targetSessionID).toBe(target.id);
    expect(merged.children[target.id]).toBeDefined();
    expect(Object.keys(current.children)).toEqual([]);
  });

  it("preserves an omitted synthetic row when its target changed live", () => {
    const target = row("ses_target", "ses_root");
    const alias = { ...row("subtask:existing", "ses_root"), targetSessionID: target.id };
    const baseline = makeState([target, alias]);
    const current = makeState([{ ...target, title: "Live target" }, alias]);
    const merged = mergeHydratedState(baseline, current, makeState([target]));
    expect(merged.children[alias.id]).toBeDefined();
    expect(merged.children[target.id]?.title).toBe("Live target");
  });

  it("rejects a new stale alias without inflating execution counters", () => {
    const target = row("ses_target", "ses_root");
    const baseline = makeState([target]);
    const current = makeState([{ ...target, title: "Live target" }]);
    const alias = { ...row("subtask:stale", "ses_root"), targetSessionID: target.id };
    const history = row("ses_history", "ses_root");
    const merged = mergeHydratedState(baseline, current, makeState([target, alias, history], {}, 999));
    expect(merged.children[alias.id]).toBeUndefined();
    expect(merged.children[history.id]).toBeDefined();
    expect(merged.totalExecuted).toBe(2);
  });

  it("preserves a live row that changed during hydration", () => {
    const baselineRow = row("ses_child", "ses_parent", "msg");
    const baseline = makeState([baselineRow]);
    const liveRow: ChildSessionState = {
      ...baselineRow,
      status: "running",
      model: { providerID: "openai", modelID: "gpt-5.6" },
      tokens: { total: 42 },
      updatedAt: RECENT_TS_LATER,
    };
    const current = makeState([liveRow]);
    const hydratedRow: ChildSessionState = {
      ...baselineRow,
      status: "done",
      color: "green",
      endedAt: RECENT_TS,
      updatedAt: RECENT_TS,
    };
    const hydrated = makeState([hydratedRow]);

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.children["ses_child"]?.status).toBe("running");
    expect(merged.children["ses_child"]?.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6",
    });
    expect(merged.children["ses_child"]?.tokens).toEqual({ total: 42 });
  });

  it("does not resurrect a row deleted during hydration", () => {
    const baselineRow = row("ses_child", "ses_parent", "msg");
    const baseline = makeState([baselineRow]);
    const current = makeState([]);
    const hydratedRow: ChildSessionState = {
      ...baselineRow,
      status: "done",
      color: "green",
      endedAt: RECENT_TS,
      updatedAt: RECENT_TS,
    };
    const hydrated = makeState([hydratedRow]);

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.children["ses_child"]).toBeUndefined();
  });

  it("applies hydrated row when live row matches baseline reference", () => {
    const baselineRow = row("ses_child", "ses_parent", "msg");
    const baseline = makeState([baselineRow]);
    const current = makeState([baselineRow]);
    const hydratedRow: ChildSessionState = {
      ...baselineRow,
      status: "done",
      color: "green",
      endedAt: RECENT_TS,
      updatedAt: RECENT_TS,
    };
    const hydrated = makeState([hydratedRow]);

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.children["ses_child"]?.status).toBe("done");
    expect(merged.children["ses_child"]?.endedAt).toBe(RECENT_TS);
  });

  it("removes a baseline row when hydrated draft omits it", () => {
    const baselineRow = row("ses_child", "ses_parent", "msg");
    const baseline = makeState([baselineRow]);
    const current = makeState([baselineRow]);
    const hydrated = makeState([]);

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.children["ses_child"]).toBeUndefined();
  });

  it("skips stale synthetic aliases whose target changed since baseline", () => {
    const baselineParent = row("ses_parent", "ses_root");
    const baselineSynthetic: ChildSessionState = {
      ...row("subtask:old", "ses_parent", "msg_old"),
      targetSessionID: "ses_parent",
    };
    const baseline = makeState([baselineParent, baselineSynthetic]);
    const liveParent: ChildSessionState = {
      ...baselineParent,
      status: "running",
      updatedAt: RECENT_TS_LATER,
    };
    const current = makeState([liveParent, baselineSynthetic]);
    const hydratedSynthetic: ChildSessionState = {
      ...baselineSynthetic,
      targetSessionID: "ses_parent",
      title: "stale alias",
    };
    const hydrated = makeState([hydratedSynthetic]);

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.children["subtask:old"]?.title).toBe("subtask:old");
  });

  it("does not inflate counters when skipping stale synthetic aliases", () => {
    const baselineParent = row("ses_parent", "ses_root");
    const baselineSynthetic: ChildSessionState = {
      ...row("subtask:old", "ses_parent", "msg_old"),
      targetSessionID: "ses_parent",
    };
    const baseline = makeState([baselineParent, baselineSynthetic], {}, 5);
    const liveParent: ChildSessionState = {
      ...baselineParent,
      status: "running",
      updatedAt: RECENT_TS_LATER,
    };
    const current = makeState([liveParent, baselineSynthetic], {}, 5);
    const hydratedSynthetic: ChildSessionState = {
      ...baselineSynthetic,
      targetSessionID: "ses_parent",
      title: "stale alias",
    };
    const hydrated = makeState(
      [hydratedSynthetic],
      { "subtask:old": true },
      6,
    );

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.children["subtask:old"]?.title).toBe("subtask:old");
    expect(merged.children["ses_parent"]?.status).toBe("running");
  });

  it("merges an unrelated historical row that did not change", () => {
    const baselineUnrelated = row("ses_unrelated", "ses_root");
    const baseline = makeState([baselineUnrelated]);
    const current = makeState([baselineUnrelated]);
    const hydratedUnrelated: ChildSessionState = {
      ...baselineUnrelated,
      status: "done",
      color: "green",
      endedAt: RECENT_TS,
      updatedAt: RECENT_TS,
    };
    const hydrated = makeState([hydratedUnrelated]);

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.children["ses_unrelated"]?.status).toBe("done");
  });

  it("preserves a new live row that did not exist in baseline", () => {
    const baseline = makeState([]);
    const liveRow = row("ses_new", "ses_root");
    const current = makeState([liveRow]);
    const hydrated = makeState([]);

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.children["ses_new"]?.id).toBe("ses_new");
    expect(merged.children["ses_new"]?.status).toBe("running");
  });

  it("does not copy counters from hydrated draft", () => {
    const baselineRow = row("ses_child", "ses_parent", "msg");
    const baseline = makeState([baselineRow], {}, 10);
    const current = makeState([baselineRow], {}, 10);
    const hydratedRow: ChildSessionState = {
      ...baselineRow,
      status: "done",
      color: "green",
      endedAt: RECENT_TS,
      updatedAt: RECENT_TS,
    };
    const hydrated = makeState([hydratedRow], { "ses_child": true }, 99);

    const merged = mergeHydratedState(baseline, current, hydrated);

    expect(merged.totalExecuted).not.toBe(99);
    expect(merged.countedChildIDs["ses_child"]).toBe(true);
  });
});
