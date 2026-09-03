/// <reference types="node" />

import type { ChildTokenState } from "./state.js";
import { createStableMaxHeap } from "./tui-hydration-heap.js";

export const ROUTE_CHILD_MESSAGE_CONCURRENCY = 4;
export const ROUTE_CHILD_MESSAGE_LIMIT = 50;
export const TOKEN_HYDRATION_CONCURRENCY = 2;
export const TOKEN_HYDRATION_ADMISSION_LIMIT = 128;
export const HYDRATE_RETRY_MAX_ATTEMPTS = 6;

const HYDRATE_RETRY_BASE_DELAY_MS = 1_000;
const HYDRATE_RETRY_MAX_DELAY_MS = 30_000;

export type TokenHydrationJob = {
  readonly childID: string;
  readonly baseline: ChildTokenState | undefined;
  readonly priority?: number;
  readonly generation?: number;
  readonly signal?: AbortSignal;
};

type TokenHydrationQueueInput = {
  readonly hydrate: (
    job: TokenHydrationJob,
  ) => Promise<ChildTokenState | undefined>;
  readonly commit: (
    job: TokenHydrationJob,
    tokens: ChildTokenState,
  ) => void;
  readonly onError: (error: Error, job: TokenHydrationJob) => void;
  readonly isValid?: (job: TokenHydrationJob) => boolean;
};

export type TokenHydrationQueue = {
  readonly enqueue: (job: TokenHydrationJob) => boolean;
  readonly idle: () => Promise<void>;
  readonly dispose: () => void;
};

export function createTokenHydrationQueue(
  input: TokenHydrationQueueInput,
): TokenHydrationQueue {
  const pending = createStableMaxHeap<TokenHydrationJob>(
    (job) => job.priority ?? 0,
  );
  const admitted = new Set<string>();
  const idleResolvers: Array<() => void> = [];
  let active = 0;
  let closed = false;
  let pumpScheduled = false;

  const jobKey = (job: TokenHydrationJob): string =>
    `${job.generation ?? 0}:${job.childID}`;

  const isValid = (job: TokenHydrationJob): boolean =>
    !closed &&
    job.signal?.aborted !== true &&
    (input.isValid?.(job) ?? true);

  const resolveIdle = (): void => {
    if (active > 0 || pending.length > 0 || pumpScheduled) return;
    for (const resolve of idleResolvers.splice(0)) resolve();
  };

  const pump = (): void => {
    while (
      !closed &&
      active < TOKEN_HYDRATION_CONCURRENCY &&
      pending.length > 0
    ) {
      const job = pending.pop();
      if (!job) break;
      const key = jobKey(job);
      active += 1;
      void (async () => {
        try {
          if (!isValid(job)) return;
          const tokens = await input.hydrate(job);
          if (tokens && isValid(job)) input.commit(job, tokens);
        } catch (error) {
          if (error instanceof Error) input.onError(error, job);
          else throw error;
        } finally {
          active -= 1;
          admitted.delete(key);
          pump();
          resolveIdle();
        }
      })();
    }
    resolveIdle();
  };

  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  };

  return {
    enqueue(job) {
      const key = jobKey(job);
      if (
        closed ||
        job.signal?.aborted === true ||
        !(input.isValid?.(job) ?? true) ||
        admitted.has(key) ||
        admitted.size >= TOKEN_HYDRATION_ADMISSION_LIMIT
      ) {
        return false;
      }
      admitted.add(key);
      pending.push(job);
      schedulePump();
      return true;
    },
    idle() {
      if (active === 0 && pending.length === 0 && !pumpScheduled) {
        return Promise.resolve();
      }
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
    dispose() {
      if (closed) return;
      closed = true;
      pending.clear();
      admitted.clear();
      resolveIdle();
    },
  };
}

/**
 * Merges a fresh hydration result into the current token snapshot.
 *
 * The function preserves newer event-supplied fields when they have moved past
 * the baseline (taken when the hydration job was enqueued). If every field on
 * the merged result is undefined, returns `undefined` so callers can skip
 * no-op state writes.
 *
 * @returns Merged token snapshot, or `undefined` when no field is resolvable.
 */
export function mergeFreshHydratedTokens(
  current: ChildTokenState | undefined,
  baseline: ChildTokenState | undefined,
  hydrated: ChildTokenState,
): ChildTokenState | undefined {
  const merged: ChildTokenState = {
    input:
      current?.input !== baseline?.input
        ? current?.input
        : (hydrated.input ?? current?.input),
    output:
      current?.output !== baseline?.output
        ? current?.output
        : (hydrated.output ?? current?.output),
    total:
      current?.total !== baseline?.total
        ? current?.total
        : (hydrated.total ?? current?.total),
    contextPercent:
      current?.contextPercent !== baseline?.contextPercent
        ? current?.contextPercent
        : (hydrated.contextPercent ?? current?.contextPercent),
  };

  if (
    merged.input === undefined &&
    merged.output === undefined &&
    merged.total === undefined &&
    merged.contextPercent === undefined
  ) {
    return undefined;
  }

  return merged;
}

export function scheduleHydrateRetry(input: {
  readonly attempts: number;
  readonly schedule: (delayMs: number) => void;
}): number {
  if (input.attempts >= HYDRATE_RETRY_MAX_ATTEMPTS) return input.attempts;
  const nextAttempts = input.attempts + 1;
  if (nextAttempts >= HYDRATE_RETRY_MAX_ATTEMPTS) return nextAttempts;
  input.schedule(
    Math.min(
      HYDRATE_RETRY_MAX_DELAY_MS,
      HYDRATE_RETRY_BASE_DELAY_MS * 2 ** input.attempts,
    ),
  );
  return nextAttempts;
}

/**
 * Settles as soon as the route is aborted, even when the host request ignores
 * its signal. Promise.race installs rejection handlers on the host promise, so
 * an eventual rejection after abort cannot become unhandled.
 */
export async function raceRouteAbort<Value>(
  request: () => Promise<Value>,
  signal: AbortSignal,
): Promise<Value | undefined> {
  if (signal.aborted) return undefined;

  let resolveAbort: () => void = () => undefined;
  const aborted = new Promise<undefined>((resolve) => {
    resolveAbort = () => resolve(undefined);
  });
  signal.addEventListener("abort", resolveAbort, { once: true });
  try {
    return await Promise.race([request(), aborted]);
  } finally {
    signal.removeEventListener("abort", resolveAbort);
  }
}

export async function mapWithBoundedConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  worker: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Array<{ readonly value: Result } | undefined> = Array.from({
    length: items.length,
  });
  const entries = items.entries();
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  const runWorker = async (): Promise<void> => {
    for (let entry = entries.next(); !entry.done; entry = entries.next()) {
      const [index, item] = entry.value;
      results[index] = { value: await worker(item, index) };
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results.flatMap((result) => (result ? [result.value] : []));
}
