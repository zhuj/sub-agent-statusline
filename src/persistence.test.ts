import { describe, expect, test } from "vitest";
import { createPersistenceCoordinator } from "./persistence.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("persistence coordinator", () => {
  test("coalesces ordinary snapshots to the latest pending generation", async () => {
    const firstWrite = deferred<void>();
    const writes: string[] = [];
    const coordinator = createPersistenceCoordinator<string>(
      async (snapshot) => {
        writes.push(snapshot);
        if (snapshot === "first") await firstWrite.promise;
      },
    );

    const first = coordinator.request("first");
    const second = coordinator.request("second");
    const latest = coordinator.request("latest");
    firstWrite.resolve(undefined);

    await Promise.all([first, second, latest]);

    expect(writes).toEqual(["first", "latest"]);
  });

  test("does not complete a delayed terminal/error flush before paired writes finish", async () => {
    const terminalWrite = deferred<void>();
    const writes: string[] = [];
    const coordinator = createPersistenceCoordinator<string>(
      async (snapshot) => {
        writes.push(`${snapshot}:json`);
        await terminalWrite.promise;
        writes.push(`${snapshot}:text`);
      },
    );

    const terminal = coordinator.flush("error");

    expect(writes).toEqual(["error:json"]);
    let terminalSettled = false;
    void terminal.then(() => {
      terminalSettled = true;
    });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);

    terminalWrite.resolve(undefined);
    await terminal;
    expect(writes).toEqual(["error:json", "error:text"]);
  });

  test("keeps JSON and text paired for one immutable generation", async () => {
    const generations: Array<{ generation: number; snapshot: string }> = [];
    const coordinator = createPersistenceCoordinator<string>(
      async (snapshot, generation) => {
        generations.push({ generation, snapshot });
      },
    );

    await coordinator.flush("same-snapshot");

    expect(generations).toEqual([{ generation: 1, snapshot: "same-snapshot" }]);
  });

  test("does not run an older generation after a newer pending generation", async () => {
    const firstWrite = deferred<void>();
    const writes: string[] = [];
    const coordinator = createPersistenceCoordinator<string>(
      async (snapshot) => {
        writes.push(snapshot);
        if (snapshot === "old") await firstWrite.promise;
      },
    );

    const old = coordinator.request("old");
    const skipped = coordinator.request("skipped");
    const newest = coordinator.flush("newest");
    firstWrite.resolve(undefined);

    await Promise.all([old, skipped, newest]);

    expect(writes).toEqual(["old", "newest"]);
  });

  test("recovers after a rejected write", async () => {
    const writes: string[] = [];
    let shouldReject = true;
    const coordinator = createPersistenceCoordinator<string>(
      async (snapshot) => {
        writes.push(snapshot);
        if (shouldReject) {
          shouldReject = false;
          throw new Error("write failed");
        }
      },
    );

    await expect(coordinator.flush("failed")).rejects.toThrow("write failed");
    await expect(coordinator.flush("recovered")).resolves.toBeUndefined();

    expect(writes).toEqual(["failed", "recovered"]);
  });

  test("coalesces bursty ordinary requests into a single write when settleDelay is set", async () => {
    const writes: string[] = [];
    const coordinator = createPersistenceCoordinator<string>(
      async (snapshot) => {
        writes.push(snapshot);
      },
      { settleDelayMs: 20 },
    );

    void coordinator.request("a");
    void coordinator.request("b");
    const latest = coordinator.request("c");
    await latest;
    expect(writes).toEqual(["c"]);
  });

  test("flush cancels pending settle timer and writes immediately", async () => {
    const writes: string[] = [];
    const coordinator = createPersistenceCoordinator<string>(
      async (snapshot) => {
        writes.push(snapshot);
      },
      { settleDelayMs: 50 },
    );

    void coordinator.request("a");
    await coordinator.flush("b");
    expect(writes).toEqual(["b"]);
  });
});
