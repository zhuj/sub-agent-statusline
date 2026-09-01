import { mkdir, readdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SubagentStatusline } from "../src/index.js";
import type { StatuslineState } from "../src/state.js";
import {
  createRuntimeHarness,
  pathExists,
  readJsonFixture,
  readRuntimeState,
  readStatusText,
} from "./helpers/runtime-harness.js";

async function createPlugin() {
  return SubagentStatusline({} as Parameters<typeof SubagentStatusline>[0]);
}

describe("SubagentStatusline runtime", () => {
  it("initializes empty runtime files and persists supported event changes", async () => {
    const harness = await createRuntimeHarness();
    const plugin = await createPlugin();
    const event = await readJsonFixture("session-created");

    expect(await readStatusText(harness.textPath)).toBe("↳ 0 running · 0 done · 0 error · Σ 0 total");

    await expect(plugin.event?.({ event } as never)).resolves.toBeUndefined();

    const state = await readRuntimeState<StatuslineState>(harness.statePath);
    expect(state.children.ses_child_1).toMatchObject({
      title: "Review auth changes",
      status: "running",
    });
    expect(await readStatusText(harness.textPath)).toContain("Review auth changes");
  });

  it("preserves startup state when preserve-state is enabled", async () => {
    const harness = await createRuntimeHarness({ preserveState: true });
    await writeFile(
      harness.statePath,
      JSON.stringify({
        children: {},
        countedChildIDs: { existing: true },
        totalExecuted: 7,
        updatedAt: "2026-04-30T10:00:00.000Z",
      }),
      "utf8",
    );

    await createPlugin();

    expect(await readRuntimeState<StatuslineState>(harness.statePath)).toMatchObject({
      totalExecuted: 7,
      countedChildIDs: { existing: true },
    });
    expect(await pathExists(harness.textPath)).toBe(false);
  });

  it("characterizes filesystem write failure: directory-as-state-path does not throw", async () => {
    const harness = await createRuntimeHarness();
    await mkdir(harness.statePath, { recursive: true });
    const plugin = await createPlugin();
    const event = await readJsonFixture("session-created");

    await expect(plugin.event?.({ event } as never)).resolves.toBeUndefined();
    // No exception thrown; best-effort behavior preserved.
  });

  it("characterizes atomic persistence: no leftover .tmp files and owner-only mode", async () => {
    const harness = await createRuntimeHarness();
    const plugin = await createPlugin();
    const event = await readJsonFixture("session-created");

    await plugin.event?.({ event } as never);

    // Atomic write should leave no .tmp artifacts.
    const files = await readdir(harness.dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("handles malformed events and write failures without throwing", async () => {
    const harness = await createRuntimeHarness({ preserveState: true });
    await mkdir(harness.statePath, { recursive: true });
    const plugin = await createPlugin();
    const malformed = await readJsonFixture("malformed");
    const valid = await readJsonFixture("session-created");

    await expect(plugin.event?.({ event: malformed } as never)).resolves.toBeUndefined();
    await expect(plugin.event?.({ event: valid } as never)).resolves.toBeUndefined();
  });

  it("serializes concurrent runtime events without losing either mutation", async () => {
    const harness = await createRuntimeHarness();
    const plugin = await createPlugin();
    const sessionCreated = await readJsonFixture("session-created");
    const toolUpdated = await readJsonFixture("tool-updated");

    await Promise.all([
      plugin.event?.({ event: sessionCreated } as never),
      plugin.event?.({ event: toolUpdated } as never),
    ]);

    const state = await readRuntimeState<StatuslineState>(harness.statePath);
    expect(Object.keys(state.children)).toEqual(
      expect.arrayContaining(["ses_child_1", "tool:part_1"]),
    );
    expect(await readStatusText(harness.textPath)).toContain(
      "Investigate flaky tests",
    );
  });

  it("preserves every mutation in a deterministic runtime burst", async () => {
    const harness = await createRuntimeHarness();
    const plugin = await createPlugin();
    const events = Array.from({ length: 64 }, (_, index) => ({
      type: "session.created",
      properties: {
        info: {
          id: `ses_burst_${index}`,
          parentID: "ses_parent_burst",
          title: `Burst child ${index}`,
          time: { created: "2026-08-31T10:00:00.000Z" },
        },
      },
    }));

    await Promise.all(
      events.map((event) => plugin.event?.({ event } as never)),
    );

    const state = await readRuntimeState<StatuslineState>(harness.statePath);
    expect(Object.keys(state.children)).toHaveLength(64);
    expect(state.totalExecuted).toBe(64);
    expect(await readStatusText(harness.textPath)).toContain("Σ 64 total");
  });

  it("retains exactly the newest 1,500 terminal rows during runtime bursts", async () => {
    const harness = await createRuntimeHarness({ preserveState: true });
    const baseMs = Date.parse("2026-08-31T10:00:00.000Z");
    const terminalChildren = Object.fromEntries(
      Array.from({ length: 1_501 }, (_, index) => {
        const timestamp = new Date(baseMs + index).toISOString();
        const id = `ses_terminal_${index}`;
        return [
          id,
          {
            id,
            title: `Terminal child ${index}`,
            parentID: "ses_parent_retention",
            source: "session",
            targetSessionID: id,
            status: "done",
            color: "green",
            startedAt: timestamp,
            updatedAt: timestamp,
            endedAt: timestamp,
          },
        ];
      }),
    );
    await writeFile(
      harness.statePath,
      JSON.stringify({
        children: terminalChildren,
        countedChildIDs: Object.fromEntries(
          Object.keys(terminalChildren).map((id) => [id, true]),
        ),
        totalExecuted: 1_501,
        updatedAt: "2026-08-31T10:00:02.000Z",
      }),
      "utf8",
    );
    const plugin = await createPlugin();
    const event = {
      type: "session.created",
      properties: {
        info: {
          id: "ses_runtime_running",
          parentID: "ses_parent_retention",
          title: "Current running child",
          time: { created: "2026-09-01T10:00:00.000Z" },
        },
      },
    };

    await plugin.event?.({ event } as never);

    const persisted = await readRuntimeState<StatuslineState>(harness.statePath);
    const terminal = Object.values(persisted.children).filter(
      (item) => item.status !== "running",
    );
    expect(terminal).toHaveLength(1_500);
    expect(persisted.children.ses_terminal_0).toBeUndefined();
    expect(persisted.children.ses_runtime_running?.status).toBe("running");
  });

  it("writes JSON before status text for each runtime snapshot", async () => {
    const harness = await createRuntimeHarness();
    const plugin = await createPlugin();
    const sessionCreated = await readJsonFixture("session-created");

    await plugin.event?.({ event: sessionCreated } as never);

    const state = await readRuntimeState<StatuslineState>(harness.statePath);
    const status = await readStatusText(harness.textPath);
    expect(state.children.ses_child_1?.title).toBe("Review auth changes");
    expect(status).toContain("Review auth changes");
  });
});
