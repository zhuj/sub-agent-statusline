import { describe, expect, it, vi } from "vitest";
import {
  DESCENDANT_DISCOVERY_CONCURRENCY,
  discoverDescendantSessions,
  type DiscoveredSession,
} from "./tui-descendant-hydration.js";

const session = (
  id: string,
  parentID: string,
  directory = "/repo",
): DiscoveredSession => ({
  id,
  parentID,
  directory,
  title: id,
});

describe("discoverDescendantSessions", () => {
  it("discovers a deep chain iteratively and queries each real parent once", async () => {
    // Given
    const graph = new Map<string, readonly unknown[]>([
      ["ses_root", [session("ses_child", "ses_root")]],
      ["ses_child", [session("ses_grand", "ses_child")]],
      ["ses_grand", [session("ses_deep", "ses_grand")]],
      ["ses_deep", []],
    ]);
    const calls: string[] = [];

    // When
    const result = await discoverDescendantSessions({
      rootSessionID: "ses_root",
      directory: "/repo",
      signal: new AbortController().signal,
      readChildren: async (parentSessionID) => {
        calls.push(parentSessionID);
        return graph.get(parentSessionID) ?? [];
      },
    });

    // Then
    expect(result.sessions.map(({ id }) => id)).toEqual([
      "ses_child",
      "ses_grand",
      "ses_deep",
    ]);
    expect(calls).toEqual([
      "ses_root",
      "ses_child",
      "ses_grand",
      "ses_deep",
    ]);
  });

  it("walks a 2000-node chain with one request per real parent", async () => {
    // Given
    const depth = 2_000;
    const calls: string[] = [];
    const readChildren = async (
      parentID: string,
    ): Promise<readonly unknown[]> => {
      calls.push(parentID);
      const index =
        parentID === "ses_root"
          ? 0
          : Number.parseInt(parentID.slice("ses_node_".length), 10) + 1;
      return index < depth
        ? [session(`ses_node_${index}`, parentID)]
        : [];
    };

    // When
    const result = await discoverDescendantSessions({
      rootSessionID: "ses_root",
      directory: "/repo",
      signal: new AbortController().signal,
      readChildren,
    });

    // Then
    expect(result.sessions).toHaveLength(depth);
    expect(calls).toHaveLength(depth + 1);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it("rejects duplicates, cycles, mismatched parents, foreign directories, and unsupported rows", async () => {
    // Given
    const readChildren = vi.fn(
      async (parentID: string): Promise<readonly unknown[]> =>
        parentID === "ses_root"
          ? [
              session("ses_child", "ses_root"),
              session("ses_child", "ses_root"),
              session("ses_wrong", "ses_other"),
              session("ses_foreign", "ses_root", "/other"),
              { id: 42, parentID: "ses_root", directory: "/repo" },
            ]
          : [session("ses_root", "ses_child")],
    );

    // When
    const result = await discoverDescendantSessions({
      rootSessionID: "ses_root",
      directory: "/repo",
      signal: new AbortController().signal,
      readChildren,
    });

    // Then
    expect(result.sessions.map(({ id }) => id)).toEqual(["ses_child"]);
    expect(readChildren).toHaveBeenCalledTimes(2);
  });

  it("never exceeds fixed children-request concurrency", async () => {
    // Given
    let active = 0;
    let maximum = 0;
    let started = 0;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const firstLevel = Array.from({ length: 20 }, (_, index) =>
      session(`ses_${index}`, "ses_root"),
    );
    const readChildren = async (
      parentID: string,
    ): Promise<readonly unknown[]> => {
      if (parentID === "ses_root") return firstLevel;
      started += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return [];
    };

    // When
    const pending = discoverDescendantSessions({
      rootSessionID: "ses_root",
      directory: "/repo",
      signal: new AbortController().signal,
      readChildren,
    });
    await vi.waitFor(() =>
      expect(active).toBe(DESCENDANT_DISCOVERY_CONCURRENCY),
    );
    expect(started).toBe(DESCENDANT_DISCOVERY_CONCURRENCY);
    releaseGate();
    await pending;

    // Then
    expect(maximum).toBe(DESCENDANT_DISCOVERY_CONCURRENCY);
  });

  it("stops admitting work on abort and returns only verified descendants", async () => {
    // Given
    const controller = new AbortController();
    const readChildren = vi.fn(async (parentID: string) => {
      if (parentID === "ses_root") {
        return [session("ses_child", "ses_root")];
      }
      controller.abort();
      return [session("ses_late", "ses_child")];
    });

    // When
    const result = await discoverDescendantSessions({
      rootSessionID: "ses_root",
      directory: "/repo",
      signal: controller.signal,
      readChildren,
    });

    // Then
    expect(result.cancelled).toBe(true);
    expect(result.sessions.map(({ id }) => id)).toEqual(["ses_child"]);
  });

  it("preserves breadth-first order when sibling reads finish out of order", async () => {
    // Given
    let releaseFirst: (rows: readonly unknown[]) => void = () => undefined;
    let releaseSecond: (rows: readonly unknown[]) => void = () => undefined;
    const first = new Promise<readonly unknown[]>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<readonly unknown[]>((resolve) => {
      releaseSecond = resolve;
    });
    const readChildren = vi.fn((parentID: string) => {
      if (parentID === "ses_root") {
        return Promise.resolve([
          session("ses_first", "ses_root"),
          session("ses_second", "ses_root"),
        ]);
      }
      if (parentID === "ses_first") return first;
      if (parentID === "ses_second") return second;
      return Promise.resolve([]);
    });

    // When
    const pending = discoverDescendantSessions({
      rootSessionID: "ses_root",
      directory: "/repo",
      signal: new AbortController().signal,
      readChildren,
    });
    await vi.waitFor(() => expect(readChildren).toHaveBeenCalledTimes(3));
    releaseSecond([session("ses_second_leaf", "ses_second")]);
    releaseFirst([session("ses_first_leaf", "ses_first")]);
    const result = await pending;

    // Then
    expect(result.sessions.map(({ id }) => id)).toEqual([
      "ses_first",
      "ses_second",
      "ses_first_leaf",
      "ses_second_leaf",
    ]);
  });

  it("preserves verified branches when one child-list read fails", async () => {
    // Given
    const readChildren = vi.fn(async (parentID: string) => {
      if (parentID === "ses_root") {
        return [
          session("ses_good", "ses_root"),
          session("ses_failed", "ses_root"),
        ];
      }
      if (parentID === "ses_failed") throw new Error("branch unavailable");
      if (parentID === "ses_good") {
        return [session("ses_leaf", "ses_good")];
      }
      return [];
    });

    // When
    const result = await discoverDescendantSessions({
      rootSessionID: "ses_root",
      directory: "/repo",
      signal: new AbortController().signal,
      readChildren,
    });

    // Then
    expect(result.hadFailure).toBe(true);
    expect(result.sessions.map(({ id }) => id)).toEqual([
      "ses_good",
      "ses_failed",
      "ses_leaf",
    ]);
  });
});
