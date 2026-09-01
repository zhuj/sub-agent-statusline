import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChildSessionState, StatuslineState } from "./state.js";
import {
  createTuiMaintenanceTimers,
  resolveTuiMaintenanceDemand,
  runTuiStateMaintenance,
} from "./tui.js";

function child(overrides: Partial<ChildSessionState> = {}): ChildSessionState {
  return {
    id: "ses_child",
    title: "Child",
    parentID: "ses_parent",
    source: "session",
    targetSessionID: "ses_child",
    status: "done",
    color: "green",
    startedAt: "2026-07-17T09:00:00.000Z",
    updatedAt: "2026-07-17T09:01:00.000Z",
    endedAt: "2026-07-17T09:01:00.000Z",
    elapsedMs: 60_000,
    ...overrides,
  };
}

function state(children: ChildSessionState[]): StatuslineState {
  return {
    children: Object.fromEntries(children.map((item) => [item.id, item])),
    countedChildIDs: Object.fromEntries(children.map((item) => [item.id, true])),
    totalExecuted: children.length,
    updatedAt: "2026-07-17T09:01:00.000Z",
  };
}

function apiWithReadSpies() {
  const status = vi.fn(() => ({ type: "idle" }));
  const messages = vi.fn(() => [{ id: "msg_child" }]);
  const part = vi.fn(() => []);
  const api = {
    state: { session: { status, messages }, part },
  } as unknown as TuiPluginApi;
  return { api, status, messages, part };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TUI maintenance timers", () => {
  it("does no fast work for terminal-only state", () => {
    vi.useFakeTimers();
    const elapsed = vi.fn();
    const maintenance = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: elapsed,
      onMaintenanceTick: maintenance,
    });

    timers.syncElapsedTimer(false);
    vi.advanceTimersByTime(1_000);

    expect(elapsed).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    timers.dispose();
  });

  it("starts and stops elapsed ticking with running state", () => {
    vi.useFakeTimers();
    const elapsed = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: elapsed,
      onMaintenanceTick: vi.fn(),
    });

    timers.syncElapsedTimer(true);
    vi.advanceTimersByTime(2_000);
    expect(elapsed).toHaveBeenCalledTimes(2);

    timers.syncElapsedTimer(false);
    vi.advanceTimersByTime(2_000);
    expect(elapsed).toHaveBeenCalledTimes(2);
    timers.dispose();
  });

  it("keeps persistence outside elapsed-only ticks", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: vi.fn(),
      onMaintenanceTick: persist,
    });

    timers.syncElapsedTimer(true);
    vi.advanceTimersByTime(1_000);

    expect(persist).not.toHaveBeenCalled();
    timers.dispose();
  });

  it("runs reconciliation maintenance while elapsed ticking is idle", () => {
    vi.useFakeTimers();
    const reconcile = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: vi.fn(),
      onMaintenanceTick: reconcile,
    });

    timers.syncElapsedTimer(false);
    vi.advanceTimersByTime(2_000);

    expect(reconcile).toHaveBeenCalledOnce();
    timers.dispose();
  });

  it("cleans up elapsed and maintenance timers", () => {
    vi.useFakeTimers();
    const elapsed = vi.fn();
    const maintenance = vi.fn();
    const timers = createTuiMaintenanceTimers({
      onElapsedTick: elapsed,
      onMaintenanceTick: maintenance,
    });
    timers.syncElapsedTimer(true);

    timers.dispose();
    vi.advanceTimersByTime(10_000);

    expect(elapsed).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("TUI state maintenance", () => {
  it("avoids cloning or normalizing terminal-only state when no work is due", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    const { api } = apiWithReadSpies();
    const titleRead = vi.fn(() => "Child");
    const terminal = child({ tokens: { total: 42 } });
    Object.defineProperty(terminal, "title", {
      configurable: true,
      enumerable: true,
      get: titleRead,
    });
    const current = state([terminal]);
    titleRead.mockClear();

    const next = runTuiStateMaintenance(api, current);

    expect(next).toBe(current);
    expect(titleRead).not.toHaveBeenCalled();
  });

  it("reports no maintenance demand for retained terminal state with complete tokens", () => {
    const nowMs = Date.parse("2026-07-17T09:02:00.000Z");
    const current = state([child({ tokens: { total: 42 } })]);

    expect(
      resolveTuiMaintenanceDemand({
        state: current,
        nowMs,
        lastRunningReconcileAtMs: nowMs,
      }),
    ).toEqual({
      prune: false,
      reconcile: false,
      hydrateTokens: false,
    });
  });

  it("retains running token retries and due reconciliation demand", () => {
    const nowMs = Date.parse("2026-07-17T09:20:00.000Z");
    const current = state([
      child({
        status: "running",
        color: "yellow",
        endedAt: undefined,
        tokens: { total: 42 },
      }),
    ]);

    expect(
      resolveTuiMaintenanceDemand({
        state: current,
        nowMs,
        lastRunningReconcileAtMs: nowMs - 10 * 60_000,
      }),
    ).toEqual({
      prune: false,
      reconcile: true,
      hydrateTokens: true,
    });
  });

  it("performs zero history reads for terminal children with complete tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    const { api, status, messages, part } = apiWithReadSpies();
    const current = state([child({ tokens: { total: 42 } })]);

    expect(runTuiStateMaintenance(api, current)).toBe(current);
    expect(status).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(part).not.toHaveBeenCalled();
  });

  it("defers terminal token fallback reads outside synchronous maintenance", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    const { api, status, messages, part } = apiWithReadSpies();
    const current = state([child({ id: "ses_fallback" })]);

    expect(runTuiStateMaintenance(api, current)).toBe(current);

    expect(status).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(part).not.toHaveBeenCalled();
  });

  it("prunes expired terminal children while idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    const { api } = apiWithReadSpies();
    const current = state([
      child({
        id: "expired",
        tokens: { total: 1 },
        updatedAt: "2026-07-10T09:00:00.000Z",
        endedAt: "2026-07-10T09:00:00.000Z",
      }),
    ]);

    const next = runTuiStateMaintenance(api, current);

    expect(next).not.toBe(current);
    expect(next.children).toEqual({});
  });

  it("keeps the exact three-day boundary and prunes immediately after it", () => {
    vi.useFakeTimers();
    const { api } = apiWithReadSpies();
    const endedAt = "2026-07-14T09:02:00.000Z";
    const current = state([child({ endedAt, updatedAt: endedAt, tokens: { total: 1 } })]);

    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    expect(runTuiStateMaintenance(api, current)).toBe(current);

    vi.setSystemTime(new Date("2026-07-17T09:02:00.001Z"));
    expect(runTuiStateMaintenance(api, current).children).toEqual({});
  });

  it("prunes terminal overflow to the existing 1,500-row cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:02:00.000Z"));
    const { api } = apiWithReadSpies();
    const terminalChildren = Array.from({ length: 1_501 }, (_, index) =>
      child({
        id: `ses_terminal_${index}`,
        targetSessionID: `ses_terminal_${index}`,
        tokens: { total: 1 },
        endedAt: new Date(Date.parse("2026-07-17T09:00:00.000Z") + index).toISOString(),
        updatedAt: new Date(Date.parse("2026-07-17T09:00:00.000Z") + index).toISOString(),
      }),
    );

    const next = runTuiStateMaintenance(api, state(terminalChildren));

    expect(Object.keys(next.children)).toHaveLength(1_500);
    expect(next.children.ses_terminal_0).toBeUndefined();
  });
});
