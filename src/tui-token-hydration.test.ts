import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { describe, expect, it, vi } from "vitest";

import type { ChildSessionState, StatuslineState } from "./state.js";
import {
  createHydrationReadContext,
  hydrateStateTokensFromTuiState,
  type TuiStateReader,
} from "./tui-token-hydration.js";

function makeChild(overrides: Partial<ChildSessionState> = {}): ChildSessionState {
  return {
    id: "ses_child",
    title: "Child",
    parentID: "ses_parent",
    source: "session",
    targetSessionID: "ses_child",
    status: "running",
    color: "yellow",
    startedAt: "2026-07-17T09:00:00.000Z",
    updatedAt: "2026-07-17T09:00:00.000Z",
    ...overrides,
  };
}

function makeState(children: ChildSessionState[]): StatuslineState {
  return {
    children: Object.fromEntries(children.map((c) => [c.id, c])),
    countedChildIDs: Object.fromEntries(children.map((c) => [c.id, true])),
    totalExecuted: children.length,
    updatedAt: "2026-07-17T09:00:00.000Z",
  };
}

function makeReader(): {
  reader: TuiStateReader;
  status: ReturnType<typeof vi.fn>;
  messages: ReturnType<typeof vi.fn>;
  part: ReturnType<typeof vi.fn>;
} {
  const status = vi.fn();
  const messages = vi.fn();
  const part = vi.fn();
  const reader: TuiStateReader = {
    session: { status, messages },
    part,
  };
  return { reader, status, messages, part };
}

function apiWith(reader: TuiStateReader): TuiPluginApi {
  return { state: reader } as unknown as TuiPluginApi;
}

describe("HydrationReadContext cache", () => {
  it("retries failed reads within the same context", () => {
    const { reader, status } = makeReader();
    status
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockReturnValue({ type: "idle" });
    const ctx = createHydrationReadContext(reader);

    expect(ctx.sessionStatus("ses_x")).toBeUndefined();
    expect(ctx.sessionStatus("ses_x")).toEqual({ type: "idle" });
    expect(status).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenNthCalledWith(1, "ses_x");
    expect(status).toHaveBeenNthCalledWith(2, "ses_x");
  });

  it("caches successful empty messages array", () => {
    const { reader, messages } = makeReader();
    messages.mockReturnValue([]);
    const ctx = createHydrationReadContext(reader);

    expect(ctx.sessionMessages("ses_x")).toEqual([]);
    expect(ctx.sessionMessages("ses_x")).toEqual([]);
    expect(messages).toHaveBeenCalledTimes(1);
  });

  it("caches successful undefined status", () => {
    const { reader, status } = makeReader();
    status.mockReturnValue(undefined);
    const ctx = createHydrationReadContext(reader);

    expect(ctx.sessionStatus("ses_x")).toBeUndefined();
    expect(ctx.sessionStatus("ses_x")).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed messages reads", () => {
    const { reader, messages } = makeReader();
    messages.mockImplementation(() => {
      throw new Error("boom");
    });
    const ctx = createHydrationReadContext(reader);

    expect(ctx.sessionMessages("ses_x")).toBeUndefined();
    expect(ctx.sessionMessages("ses_x")).toBeUndefined();
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it("caches successful parts reads by messageID", () => {
    const { reader, part } = makeReader();
    part.mockReturnValue([]);
    const ctx = createHydrationReadContext(reader);

    expect(ctx.messageParts("msg_a")).toEqual([]);
    expect(ctx.messageParts("msg_a")).toEqual([]);
    expect(part).toHaveBeenCalledTimes(1);
  });
});

describe("hydrateStateTokensFromTuiState", () => {
  it("shares parent messages across siblings in one pass", () => {
    const { reader, messages, part } = makeReader();
    messages.mockReturnValue([{ id: "msg_parent" }]);
    part.mockReturnValue([]);
    const state = makeState([
      makeChild({ id: "ses_a", messageID: "msg_parent" }),
      makeChild({ id: "ses_b", messageID: "msg_parent" }),
    ]);

    hydrateStateTokensFromTuiState(apiWith(reader), state);

    const parentReads = messages.mock.calls.filter(
      ([sessionID]) => sessionID === "ses_parent",
    );
    expect(parentReads).toHaveLength(1);
  });

  it("shares parent parts across siblings in one pass", () => {
    const { reader, messages, part } = makeReader();
    messages.mockReturnValue([]);
    part.mockReturnValue([]);
    const state = makeState([
      makeChild({ id: "ses_a", messageID: "msg_shared" }),
      makeChild({ id: "ses_b", messageID: "msg_shared" }),
    ]);

    hydrateStateTokensFromTuiState(apiWith(reader), state);

    expect(part).toHaveBeenCalledTimes(1);
    expect(part).toHaveBeenCalledWith("msg_shared");
  });

  it("picks first duplicate parent message match", () => {
    const { reader, messages, part } = makeReader();
    messages.mockReturnValue([
      { id: "msg_dup", info: { total_tokens: 100 } },
      { id: "msg_dup", info: { total_tokens: 200 } },
    ]);
    part.mockReturnValue([]);
    const state = makeState([
      makeChild({ id: "ses_a", messageID: "msg_dup" }),
    ]);

    hydrateStateTokensFromTuiState(apiWith(reader), state);

    expect(state.children["ses_a"]?.tokens?.total).toBe(100);
  });

  it("performs fresh reads on a second hydrator call", () => {
    const { reader, status, messages, part } = makeReader();
    status.mockReturnValue({ type: "idle" });
    messages.mockReturnValue([]);
    part.mockReturnValue([]);
    const state = makeState([makeChild()]);

    hydrateStateTokensFromTuiState(apiWith(reader), state);
    hydrateStateTokensFromTuiState(apiWith(reader), state);

    expect(status).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it("performs zero reads for terminal-complete children", () => {
    const { reader, status, messages, part } = makeReader();
    const state = makeState([
      makeChild({ status: "done", tokens: { total: 42 } }),
    ]);

    hydrateStateTokensFromTuiState(apiWith(reader), state);

    expect(status).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(part).not.toHaveBeenCalled();
  });

  it("merges partial tokens from status and messages", () => {
    const { reader, status, messages, part } = makeReader();
    status.mockReturnValue({ info: { total_tokens: 50 } });
    messages.mockReturnValue([{ info: { input_tokens: 10 } }]);
    part.mockReturnValue([]);
    const state = makeState([makeChild()]);

    hydrateStateTokensFromTuiState(apiWith(reader), state);

    const tokens = state.children["ses_child"]?.tokens;
    expect(tokens?.total).toBe(50);
    expect(tokens?.input).toBe(10);
  });

  it("returns false when nothing changed", () => {
    const { reader, status, messages, part } = makeReader();
    status.mockReturnValue({ type: "idle" });
    messages.mockReturnValue([]);
    part.mockReturnValue([]);
    const state = makeState([
      makeChild({ status: "done", tokens: { total: 1 } }),
    ]);

    expect(hydrateStateTokensFromTuiState(apiWith(reader), state)).toBe(false);
  });

  it("returns true when tokens change", () => {
    const { reader, status, messages, part } = makeReader();
    status.mockReturnValue({ info: { total_tokens: 99 } });
    messages.mockReturnValue([]);
    part.mockReturnValue([]);
    const child = makeChild({ status: "running" });
    const state = makeState([child]);

    expect(hydrateStateTokensFromTuiState(apiWith(reader), state)).toBe(true);
    expect(state.children["ses_child"]).not.toBe(child);
    expect(state.children["ses_child"]?.tokens?.total).toBe(99);
    expect(child.tokens).toBeUndefined();
  });
});
