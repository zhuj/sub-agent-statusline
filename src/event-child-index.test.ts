import { describe, expect, it } from "vitest";
import { createEventChildIndex } from "./event-child-index.js";
import type { ChildSessionState } from "./state.js";

function row(overrides: Partial<ChildSessionState>): ChildSessionState {
  return {
    id: "ses_a",
    title: "A",
    parentID: "ses_parent",
    status: "running",
    color: "yellow",
    startedAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:00:00.000Z",
    ...overrides,
  };
}

describe("event child index", () => {
  it("updates same-event lookups and rejects ambiguous weak evidence", () => {
    const first = row({
      id: "ses_a",
      source: "session",
      targetSessionID: "ses_a",
      messageID: "msg",
    });
    const index = createEventChildIndex([first]);
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        [],
      ),
    ).toBe("ses_a");
    index.upsert(
      row({
        id: "ses_b",
        source: "session",
        targetSessionID: "ses_b",
        messageID: "msg",
      }),
    );
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        [],
      ),
    ).toBeUndefined();
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        ["ses_a"],
      ),
    ).toBe("ses_a");
  });

  it("treats duplicate evidence for the same session as a single match", () => {
    const index = createEventChildIndex([
      row({
        id: "ses_a",
        source: "session",
        targetSessionID: "ses_a",
        messageID: "msg",
      }),
      row({
        id: "tool:a",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg",
        targetSessionID: "ses_a",
      }),
    ]);
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        [],
      ),
    ).toBe("ses_a");
  });

  it("ignores non-session message evidence", () => {
    const index = createEventChildIndex([
      row({
        id: "tool:x",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg",
      }),
    ]);
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        [],
      ),
    ).toBeUndefined();
  });

  it("ignores non-session parent evidence", () => {
    const index = createEventChildIndex([
      row({
        id: "tool:x",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg",
      }),
    ]);
    expect(
      index.resolveSyntheticTarget({ parentID: "ses_parent" }, []),
    ).toBeUndefined();
  });

  it("filters explicit candidates to ses_ prefix only", () => {
    const index = createEventChildIndex([
      row({
        id: "ses_a",
        source: "session",
        targetSessionID: "ses_a",
        messageID: "msg",
      }),
    ]);
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        ["tool:x", "subtask:y"],
      ),
    ).toBe("ses_a");
  });

  it("fails closed when explicit candidates conflict with weak evidence", () => {
    const index = createEventChildIndex([
      row({
        id: "ses_a",
        source: "session",
        targetSessionID: "ses_a",
        messageID: "msg",
      }),
    ]);
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        ["ses_other"],
      ),
    ).toBeUndefined();
  });

  it("returns targetless synthetic siblings scoped to parent", () => {
    const index = createEventChildIndex([
      row({
        id: "tool:other",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg_other",
      }),
      row({
        id: "tool:match",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg_match",
      }),
      row({
        id: "subtask:match",
        source: "subtask",
        parentID: "ses_parent",
        messageID: "msg_match",
      }),
      row({
        id: "tool:has_target",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg_match",
        targetSessionID: "ses_target",
      }),
      row({
        id: "tool:other_parent",
        source: "tool",
        parentID: "ses_other",
        messageID: "msg_match",
      }),
    ]);
    expect(
      index.targetlessSynthetic("ses_parent").map((c) => c.id).sort(),
    ).toEqual(["subtask:match", "tool:match", "tool:other"]);
    expect(index.targetlessSynthetic("ses_other").map((c) => c.id)).toEqual([
      "tool:other_parent",
    ]);
  });

  it("returns running subtasks scoped to parent", () => {
    const index = createEventChildIndex([
      row({
        id: "subtask:a",
        source: "subtask",
        parentID: "ses_parent",
        messageID: "msg_1",
        status: "running",
      }),
      row({
        id: "subtask:b",
        source: "subtask",
        parentID: "ses_parent",
        messageID: "msg_1",
        status: "done",
        color: "green",
      }),
      row({
        id: "subtask:c",
        source: "subtask",
        parentID: "ses_other",
        messageID: "msg_1",
        status: "running",
      }),
      row({
        id: "tool:d",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg_1",
        status: "running",
      }),
    ]);
    expect(index.runningSubtasks("ses_parent").map((c) => c.id)).toEqual([
      "subtask:a",
    ]);
  });

  it("returns real session siblings scoped to parent", () => {
    const index = createEventChildIndex([
      row({
        id: "ses_existing",
        source: "session",
        targetSessionID: "ses_existing",
        parentID: "ses_parent",
      }),
      row({
        id: "ses_new",
        source: "session",
        targetSessionID: "ses_new",
        parentID: "ses_parent",
      }),
      row({
        id: "tool:wrapper",
        source: "tool",
        parentID: "ses_parent",
      }),
      row({
        id: "ses_other_parent",
        source: "session",
        targetSessionID: "ses_other_parent",
        parentID: "ses_other",
      }),
    ]);
    expect(
      index.realSessionSiblings("ses_parent").map((c) => c.id).sort(),
    ).toEqual(["ses_existing", "ses_new"]);
  });

  it("upsert cleans stale memberships", () => {
    const index = createEventChildIndex([
      row({
        id: "tool:wrap",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg_old",
      }),
    ]);
    expect(index.targetlessSynthetic("ses_parent").map((c) => c.id)).toEqual([
      "tool:wrap",
    ]);
    index.upsert(
      row({
        id: "tool:wrap",
        source: "tool",
        parentID: "ses_parent",
        messageID: "msg_new",
        targetSessionID: "ses_target",
      }),
    );
    expect(index.targetlessSynthetic("ses_parent")).toEqual([]);
  });

  it("remove cleans every membership for the deleted child", () => {
    const index = createEventChildIndex([
      row({
        id: "subtask:a",
        source: "subtask",
        parentID: "ses_parent",
        messageID: "msg",
      }),
      row({
        id: "ses_a",
        source: "session",
        parentID: "ses_parent",
        messageID: "msg",
        targetSessionID: "ses_a",
      }),
    ]);

    index.remove("subtask:a");
    expect(index.runningSubtasks("ses_parent")).toEqual([]);
    expect(index.targetlessSynthetic("ses_parent")).toEqual([]);
    index.remove("ses_a");
    expect(index.realSessionSiblings("ses_parent")).toEqual([]);
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        [],
      ),
    ).toBeUndefined();
  });

  it("upsert removes stale running-subtask membership when status changes", () => {
    const index = createEventChildIndex([
      row({
        id: "subtask:a",
        source: "subtask",
        parentID: "ses_parent",
        messageID: "msg_1",
        status: "running",
      }),
    ]);
    expect(index.runningSubtasks("ses_parent").map((c) => c.id)).toEqual([
      "subtask:a",
    ]);
    index.upsert(
      row({
        id: "subtask:a",
        source: "subtask",
        parentID: "ses_parent",
        messageID: "msg_1",
        status: "done",
        color: "green",
      }),
    );
    expect(index.runningSubtasks("ses_parent")).toEqual([]);
  });

  it("upsert returns the current object for same-event reads", () => {
    const original = row({
      id: "ses_a",
      source: "session",
      targetSessionID: "ses_a",
      messageID: "msg",
    });
    const index = createEventChildIndex([original]);
    const replacement = row({
      id: "ses_a",
      source: "session",
      targetSessionID: "ses_a",
      messageID: "msg",
      title: "Updated title",
    });
    index.upsert(replacement);
    expect(
      index.resolveSyntheticTarget(
        { parentID: "ses_parent", messageID: "msg" },
        [],
      ),
    ).toBe("ses_a");
    expect(index.realSessionSiblings("ses_parent")[0]).toBe(replacement);
  });
});
