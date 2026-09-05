import { describe, expect, it, vi } from "vitest";

import { createDiscoveryMetadataLoader } from "./tui-discovery-metadata.js";

function metadata(
  id: string,
  parentID: string | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { id, ...extra };
  if (parentID !== undefined) out.parentID = parentID;
  return out;
}

describe("createDiscoveryMetadataLoader", () => {
  it("prefers newly available host metadata over a cached remote failure", async () => {
    const readCached = vi.fn<() => unknown>(() => undefined);
    const readRemote = vi.fn(async () => undefined);
    const load = createDiscoveryMetadataLoader(readCached, readRemote, () => 0);
    expect((await load(["ses_leaf"], new Set(["ses_root"]))).size).toBe(0);
    readCached.mockReturnValue(metadata("ses_leaf", "ses_root"));
    expect((await load(["ses_leaf"], new Set(["ses_root"]))).has("ses_leaf")).toBe(true);
    expect(readRemote).toHaveBeenCalledOnce();
  });

  it("resolves a missing leaf, its parent, and stops at a known root", async () => {
    const readCached = vi.fn((id: string) => {
      if (id === "ses_root") return metadata("ses_root", undefined, { title: "root" });
      throw new Error("missing");
    });
    const readRemote = vi.fn(async (id: string) => {
      if (id === "ses_leaf") return metadata("ses_leaf", "ses_parent", { title: "leaf" });
      if (id === "ses_parent") return metadata("ses_parent", "ses_root", { title: "parent" });
      throw new Error("unexpected " + id);
    });
    const load = createDiscoveryMetadataLoader(readCached, readRemote);

    const result = await load(["ses_leaf"], new Set(["ses_root"]));

    expect(readRemote).toHaveBeenCalledTimes(2);
    expect(readRemote.mock.calls.map((c) => c[0])).toEqual(["ses_leaf", "ses_parent"]);
    expect(result.get("ses_leaf")).toMatchObject({ id: "ses_leaf", parentID: "ses_parent" });
    expect(result.get("ses_parent")).toMatchObject({ id: "ses_parent", parentID: "ses_root" });
    expect(result.has("ses_root")).toBe(false);
  });

  it("reuses remote results within TTL and refreshes them after expiry", async () => {
    let now = 1_000;
    const nowFn = vi.fn(() => now);
    const readCached = vi.fn(() => {
      throw new Error("none");
    });
    const readRemote = vi.fn(async (id: string) => metadata(id, undefined));
    const load = createDiscoveryMetadataLoader(readCached, readRemote, nowFn);

    const first = await load(["ses_a"], new Set());
    expect(first.get("ses_a")).toMatchObject({ id: "ses_a" });
    expect(readRemote).toHaveBeenCalledTimes(1);

    const second = await load(["ses_a"], new Set());
    expect(second.get("ses_a")).toMatchObject({ id: "ses_a" });
    expect(readRemote).toHaveBeenCalledTimes(1);

    now += 60_001;
    const third = await load(["ses_a"], new Set());
    expect(third.get("ses_a")).toMatchObject({ id: "ses_a" });
    expect(readRemote).toHaveBeenCalledTimes(2);
  });

  it("performs zero remote reads when all seeds are known", async () => {
    const readCached = vi.fn();
    const readRemote = vi.fn();
    const load = createDiscoveryMetadataLoader(readCached, readRemote);

    const result = await load(
      ["ses_a", "ses_b"],
      new Set(["ses_a", "ses_b", "ses_root"]),
    );

    expect(readRemote).not.toHaveBeenCalled();
    expect(readCached).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it("caches failures and recovers after the TTL elapses", async () => {
    let now = 0;
    const nowFn = vi.fn(() => now);
    const readCached = vi.fn(() => {
      throw new Error("none");
    });
    const readRemote = vi.fn(async (id: string) => {
      if (now < 60_001) throw new Error("boom");
      return metadata(id, undefined);
    });
    const load = createDiscoveryMetadataLoader(readCached, readRemote, nowFn);

    const first = await load(["ses_x"], new Set());
    expect(first.size).toBe(0);
    expect(readRemote).toHaveBeenCalledTimes(1);

    const second = await load(["ses_x"], new Set());
    expect(second.size).toBe(0);
    expect(readRemote).toHaveBeenCalledTimes(1);

    now = 60_001;
    const third = await load(["ses_x"], new Set());
    expect(third.get("ses_x")).toMatchObject({ id: "ses_x" });
    expect(readRemote).toHaveBeenCalledTimes(2);
  });

  it("ignores cached entries whose id does not match the requested id", async () => {
    const readCached = vi.fn((id: string) => {
      if (id === "ses_a") return { id: "ses_other", parentID: "ses_root" };
      throw new Error("none");
    });
    const readRemote = vi.fn(async (id: string) => metadata(id, "ses_root"));
    const load = createDiscoveryMetadataLoader(readCached, readRemote);

    const result = await load(["ses_a"], new Set(["ses_root"]));

    expect(readRemote).toHaveBeenCalledTimes(1);
    expect(readRemote).toHaveBeenCalledWith("ses_a");
    expect(result.get("ses_a")).toMatchObject({ id: "ses_a", parentID: "ses_root" });
  });

  it("bounds concurrency to <=8 and total remote calls to <=32", async () => {
    const readCached = vi.fn(() => {
      throw new Error("none");
    });
    let inFlight = 0;
    let peak = 0;
    const calls: string[] = [];
    const readRemote = vi.fn(async (id: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      calls.push(id);
      await Promise.resolve();
      inFlight--;
      const parent = "p_" + id;
      return metadata(id, parent);
    });
    const load = createDiscoveryMetadataLoader(readCached, readRemote);

    const seeds: string[] = [];
    for (let i = 0; i < 200; i++) seeds.push("ses_s" + i);

    const result = await load(seeds, new Set());

    expect(peak).toBeLessThanOrEqual(8);
    expect(readRemote.mock.calls.length).toBe(32);
    expect(result.size).toBe(32);
    await load(seeds, new Set());
    expect(calls.length).toBe(64);
  });

  it("terminates traversal on cycles and does not loop forever", async () => {
    const readCached = vi.fn(() => {
      throw new Error("none");
    });
    const readRemote = vi.fn(async (id: string) => {
      if (id === "ses_a") return metadata("ses_a", "ses_b");
      if (id === "ses_b") return metadata("ses_b", "ses_a");
      throw new Error("unexpected " + id);
    });
    const load = createDiscoveryMetadataLoader(readCached, readRemote);

    const result = await load(["ses_a"], new Set());

    expect(readRemote).toHaveBeenCalledTimes(2);
    expect(result.get("ses_a")).toMatchObject({ id: "ses_a" });
    expect(result.get("ses_b")).toMatchObject({ id: "ses_b" });
  });

  it("stops scheduling further reads after cancellation and returns accumulated data", async () => {
    const readCached = vi.fn(() => {
      throw new Error("none");
    });
    const readRemote = vi.fn(async (id: string) => metadata(id, "ses_parent"));
    const shouldContinue = vi.fn(() => true);
    shouldContinue.mockImplementationOnce(() => true);
    shouldContinue.mockImplementationOnce(() => false);
    const load = createDiscoveryMetadataLoader(readCached, readRemote);

    const seeds = ["ses_1", "ses_2", "ses_3", "ses_4", "ses_5", "ses_6", "ses_7", "ses_8", "ses_9"];
    const result = await load(seeds, new Set(), shouldContinue);

    expect(readRemote.mock.calls.length).toBeLessThanOrEqual(8);
    expect(shouldContinue.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.size).toBeGreaterThan(0);
  });

  it("reuses remote results across calls for a shared ancestor", async () => {
    const readCached = vi.fn(() => {
      throw new Error("none");
    });
    const readRemote = vi.fn(async (id: string) => {
      if (id === "ses_shared") return metadata("ses_shared", "ses_root", { title: "shared" });
      if (id === "ses_a") return metadata("ses_a", "ses_shared");
      if (id === "ses_b") return metadata("ses_b", "ses_shared");
      throw new Error("unexpected " + id);
    });
    const load = createDiscoveryMetadataLoader(readCached, readRemote);

    const result = await load(["ses_a", "ses_b"], new Set(["ses_root"]));

    const sharedCalls = readRemote.mock.calls.filter((c) => c[0] === "ses_shared").length;
    expect(sharedCalls).toBe(1);
    expect(result.get("ses_shared")).toMatchObject({ id: "ses_shared", parentID: "ses_root" });
  });
});
