import { describe, expect, it, vi } from "vitest";
import {
  createTokenHydrationQueue,
  TOKEN_HYDRATION_ADMISSION_LIMIT,
  TOKEN_HYDRATION_CONCURRENCY,
} from "./tui-hydration.js";

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createTokenHydrationQueue", () => {
  it("processes priorities first and keeps equal-priority jobs FIFO", async () => {
    // Given
    const processed: string[] = [];
    const queue = createTokenHydrationQueue({
      hydrate: ({ childID }) => {
        processed.push(childID);
        return Promise.resolve(undefined);
      },
      commit: () => undefined,
      onError: () => undefined,
    });

    // When
    expect(
      queue.enqueue({ childID: "low", baseline: undefined, priority: 1 }),
    ).toBe(true);
    expect(
      queue.enqueue({ childID: "equal-first", baseline: undefined, priority: 5 }),
    ).toBe(true);
    expect(
      queue.enqueue({ childID: "high", baseline: undefined, priority: 10 }),
    ).toBe(true);
    expect(
      queue.enqueue({ childID: "equal-second", baseline: undefined, priority: 5 }),
    ).toBe(true);

    // Then
    await queue.idle();
    expect(processed).toEqual([
      "high",
      "equal-first",
      "equal-second",
      "low",
    ]);
    queue.dispose();
  });

  it("rejects duplicate keys and jobs beyond the admission limit", async () => {
    // Given
    const processed: string[] = [];
    const queue = createTokenHydrationQueue({
      hydrate: ({ childID }) => {
        processed.push(childID);
        return Promise.resolve(undefined);
      },
      commit: () => undefined,
      onError: () => undefined,
    });

    // When
    expect(queue.enqueue({ childID: "ses_0", baseline: undefined })).toBe(true);
    expect(queue.enqueue({ childID: "ses_0", baseline: undefined })).toBe(false);
    for (let index = 1; index < TOKEN_HYDRATION_ADMISSION_LIMIT; index += 1) {
      expect(
        queue.enqueue({ childID: `ses_${index}`, baseline: undefined }),
      ).toBe(true);
    }
    expect(
      queue.enqueue({ childID: "ses_overflow", baseline: undefined }),
    ).toBe(false);

    // Then
    await queue.idle();
    expect(processed).toHaveLength(TOKEN_HYDRATION_ADMISSION_LIMIT);
    expect(queue.enqueue({ childID: "ses_0", baseline: undefined })).toBe(true);
    await queue.idle();
    expect(processed).toHaveLength(TOKEN_HYDRATION_ADMISSION_LIMIT + 1);
    queue.dispose();
  });

  it("bounds active hydration and resolves idle only after all jobs finish", async () => {
    // Given
    const started: string[] = [];
    const gates = new Map<string, Deferred<undefined>>();
    let active = 0;
    let maximumActive = 0;
    const queue = createTokenHydrationQueue({
      hydrate: async ({ childID }) => {
        started.push(childID);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const gate = deferred<undefined>();
        gates.set(childID, gate);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      },
      commit: () => undefined,
      onError: () => undefined,
    });
    queue.enqueue({ childID: "first", baseline: undefined });
    queue.enqueue({ childID: "second", baseline: undefined });
    queue.enqueue({ childID: "third", baseline: undefined });
    let idleResolved = false;
    const idlePromise = queue.idle().then(() => {
      idleResolved = true;
    });

    // When
    await flushMicrotasks();

    // Then
    expect(started).toEqual(["first", "second"]);
    expect(maximumActive).toBe(TOKEN_HYDRATION_CONCURRENCY);
    expect(idleResolved).toBe(false);

    const firstGate = gates.get("first");
    if (!firstGate) throw new Error("first hydration gate was not created");
    firstGate.resolve(undefined);
    await flushMicrotasks();
    expect(started).toEqual(["first", "second", "third"]);
    expect(idleResolved).toBe(false);

    const secondGate = gates.get("second");
    const thirdGate = gates.get("third");
    if (!secondGate || !thirdGate) {
      throw new Error("all hydration gates were not created");
    }
    secondGate.resolve(undefined);
    thirdGate.resolve(undefined);
    await idlePromise;
    expect(idleResolved).toBe(true);
    expect(active).toBe(0);
    queue.dispose();
  });

  it("disposes pending work and ignores results from active work", async () => {
    // Given
    const started: string[] = [];
    const committed: string[] = [];
    const gates = new Map<string, Deferred<{ readonly total: number }>>();
    const queue = createTokenHydrationQueue({
      hydrate: ({ childID }) => {
        started.push(childID);
        const gate = deferred<{ readonly total: number }>();
        gates.set(childID, gate);
        return gate.promise;
      },
      commit: ({ childID }) => {
        committed.push(childID);
      },
      onError: () => undefined,
    });
    queue.enqueue({ childID: "first", baseline: undefined });
    queue.enqueue({ childID: "second", baseline: undefined });
    queue.enqueue({ childID: "pending", baseline: undefined });
    await flushMicrotasks();

    // When
    queue.dispose();
    expect(queue.enqueue({ childID: "after-dispose", baseline: undefined })).toBe(
      false,
    );
    const firstGate = gates.get("first");
    const secondGate = gates.get("second");
    if (!firstGate || !secondGate) {
      throw new Error("active hydration gates were not created");
    }
    firstGate.resolve({ total: 1 });
    secondGate.resolve({ total: 2 });

    // Then
    await queue.idle();
    expect(started).toEqual(["first", "second"]);
    expect(committed).toEqual([]);
  });

  it("reports Error failures and still reaches idle", async () => {
    // Given
    const processed: string[] = [];
    const failures: string[] = [];
    const queue = createTokenHydrationQueue({
      hydrate: ({ childID }) => {
        processed.push(childID);
        if (childID === "failed") {
          return Promise.reject(new Error("hydration failed"));
        }
        return Promise.resolve(undefined);
      },
      commit: () => undefined,
      onError: (error, job) => {
        failures.push(`${job.childID}:${error.message}`);
      },
    });
    queue.enqueue({ childID: "failed", baseline: undefined });
    queue.enqueue({ childID: "succeeds", baseline: undefined });

    // When
    await queue.idle();

    // Then
    expect(processed).toEqual(["failed", "succeeds"]);
    expect(failures).toEqual(["failed:hydration failed"]);
    queue.dispose();
  });

  it("does not sort the pending queue during enqueue", async () => {
    // Given
    const sort = vi.spyOn(Array.prototype, "sort");
    const queue = createTokenHydrationQueue({
      hydrate: () => Promise.resolve(undefined),
      commit: () => undefined,
      onError: () => undefined,
    });

    // When
    expect(
      queue.enqueue({ childID: "low", baseline: undefined, priority: 1 }),
    ).toBe(true);
    expect(
      queue.enqueue({ childID: "high", baseline: undefined, priority: 2 }),
    ).toBe(true);
    expect(
      queue.enqueue({ childID: "middle", baseline: undefined, priority: 1 }),
    ).toBe(true);
    const sortCalls = sort.mock.calls.length;
    sort.mockRestore();

    // Then
    expect(sortCalls).toBe(0);
    await queue.idle();
    queue.dispose();
  });
});
