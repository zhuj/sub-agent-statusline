import { describe, expect, it } from "vitest";

import type { ChildSessionState } from "./state.js";
import { createHydrationTransactionIndex } from "./tui-hydration-index.js";

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
