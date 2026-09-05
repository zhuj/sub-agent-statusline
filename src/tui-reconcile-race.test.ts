import { expect, it, vi } from "vitest";
import type { StatuslineState } from "./state.js";
import tuiPlugin from "./tui.js";

vi.mock("@opentui/solid/jsx-runtime", () => ({
  jsx: (_type: unknown, props: unknown) => props,
  jsxs: (_type: unknown, props: unknown) => props,
  Fragment: Symbol(),
}));
vi.mock("@opentui/solid/jsx-dev-runtime", () => ({
  jsxDEV: (_type: unknown, props: unknown) => props,
  Fragment: Symbol(),
}));

it.each([false, true])("preserves a flushed alias update while a probe waits (timestamp collision: %s)", async (sameTimestamp) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  let dispose: (() => void) | undefined;
  let release: ((value: { data: Record<string, unknown> }) => void) | undefined;
  let notify: (() => void) | undefined;
  const pendingStatus = new Promise<{ data: Record<string, unknown> }>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { notify = resolve; });
  const handlers = new Map<string, (event: unknown) => void>();
  let homeBottom: (ctx: unknown) => unknown = () => { throw new Error("Missing slot"); };
  const api = {
    state: {
      path: { directory: "/repo" }, provider: [],
      session: { get: vi.fn(), status: vi.fn(() => ({ type: "busy" })), messages: vi.fn(() => []) },
      part: vi.fn(() => []),
    },
    route: { current: { name: "session", params: { sessionID: "ses_root" } } },
    kv: { get<Value>(_key: string, fallback: Value): Value { return fallback; }, set: vi.fn() },
    client: { session: {
      children: vi.fn(async () => ({ data: [] })),
      messages: vi.fn(async () => ({ data: [] })),
      status: vi.fn(() => { notify?.(); return pendingStatus; }),
    } },
    event: { on: vi.fn((name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler); return vi.fn();
    }) },
    lifecycle: { onDispose: vi.fn((callback: () => void) => { dispose = callback; }) },
    slots: { register: vi.fn((registration: { slots: { home_bottom: (ctx: unknown) => unknown } }) => {
      homeBottom = registration.slots.home_bottom;
    }) },
    ui: { dialog: { clear: vi.fn() }, toast: vi.fn(), Prompt: vi.fn(), Slot: vi.fn() },
  };
  const aliasEvent = (description: string) => ({
    type: "message.part.updated", properties: {
      sessionID: "ses_root", part: {
        id: "alias", type: "tool", tool: "task", sessionID: "ses_root", messageID: "msg_alias",
        state: { status: "running", input: { description }, metadata: { sessionId: "ses_real" } },
      },
    },
  });
  try {
    await tuiPlugin.tui(api as never, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(0);
    const { state: readState } = homeBottom({ theme: { current: {} } }) as { state: () => StatuslineState };
    expect(readState).toBeTypeOf("function");
    const statusBaseline = api.client.session.status.mock.calls.length;
    handlers.get("session.created")?.({ type: "session.created", properties: {
      info: { id: "ses_real", parentID: "ses_root", title: "Real session" },
    } });
    handlers.get("message.part.updated")?.(aliasEvent("Old alias"));
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    expect(api.client.session.status).toHaveBeenCalledTimes(statusBaseline + 1);
    expect(readState().children["tool:alias"]?.title).toBe("Old alias");
    if (sameTimestamp) vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    handlers.get("message.part.updated")?.(aliasEvent("New alias"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readState().children["tool:alias"]?.title).toBe("New alias");
    release?.({ data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(readState().children.ses_real?.status).toBe("done");
    expect(readState().children["tool:alias"]).toMatchObject({ status: "running", title: "New alias" });
  } finally {
    release?.({ data: {} });
    dispose?.();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
