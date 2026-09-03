export type PersistenceWriter<Snapshot> = (
  snapshot: Snapshot,
  generation: number,
) => Promise<void>;

type PersistenceJob<Snapshot> = {
  readonly snapshot: Snapshot;
  readonly generation: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
};

export type PersistenceCoordinator<Snapshot> = {
  request(snapshot: Snapshot): Promise<void>;
  flush(snapshot: Snapshot): Promise<void>;
  close(): void;
};

export type PersistenceCoordinatorOptions<Snapshot> = {
  /**
   * Delay before the first write of an ordinary (non-flush) request. When
   * non-zero, `request()` waits this long before pumping so a burst of
   * events within the same micro-tick can collapse to a single write.
   * Flushes always pump immediately. Defaults to 0 for backwards compat.
   */
  readonly settleDelayMs?: number;
  readonly combineSnapshots?: (
    accumulated: Snapshot,
    incoming: Snapshot,
  ) => Snapshot;
};

export function createPersistenceCoordinator<Snapshot>(
  writer: PersistenceWriter<Snapshot>,
  options: PersistenceCoordinatorOptions<Snapshot> = {},
): PersistenceCoordinator<Snapshot> {
  const settleDelayMs = options.settleDelayMs ?? 0;
  let nextGeneration = 0;
  let inFlight = false;
  let closed = false;
  let pendingOrdinary: PersistenceJob<Snapshot> | undefined;
  let pendingFlush: PersistenceJob<Snapshot> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const combineSnapshots = (
    accumulated: Snapshot,
    incoming: Snapshot,
  ): Snapshot =>
    options.combineSnapshots === undefined
      ? incoming
      : options.combineSnapshots(accumulated, incoming);

  const clearSettleTimer = (): void => {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  };

  const settleSuperseded = (job: PersistenceJob<Snapshot>): void => {
    job.resolve();
  };

  const selectNext = (): PersistenceJob<Snapshot> | undefined => {
    const flush = pendingFlush;
    pendingFlush = undefined;
    if (flush) return flush;
    const ordinary = pendingOrdinary;
    pendingOrdinary = undefined;
    return ordinary;
  };

  const pump = (): void => {
    clearSettleTimer();
    if (inFlight) return;
    const job = selectNext();
    if (!job) return;
    inFlight = true;
    void (async () => {
      try {
        await writer(job.snapshot, job.generation);
        job.resolve();
      } catch (error) {
        job.reject(error);
      } finally {
        inFlight = false;
        pump();
      }
    })();
  };

  const scheduleSettlePump = (): void => {
    if (settleTimer !== undefined) return;
    if (settleDelayMs <= 0) {
      pump();
      return;
    }
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      pump();
    }, settleDelayMs);
  };

  const enqueue = (
    snapshot: Snapshot,
    flush: boolean,
  ): Promise<void> => {
    if (closed) return Promise.resolve();

    const generation = ++nextGeneration;
    let queuedSnapshot = snapshot;
    if (flush) {
      const supersededJobs: Array<PersistenceJob<Snapshot>> = [];
      if (pendingFlush !== undefined) supersededJobs.push(pendingFlush);
      if (pendingOrdinary !== undefined) supersededJobs.push(pendingOrdinary);
      supersededJobs.sort((left, right) => right.generation - left.generation);
      for (const supersededJob of supersededJobs) {
        queuedSnapshot = combineSnapshots(
          supersededJob.snapshot,
          queuedSnapshot,
        );
      }
    } else if (pendingOrdinary !== undefined) {
      queuedSnapshot = combineSnapshots(pendingOrdinary.snapshot, snapshot);
    }

    let resolveJob: () => void = () => undefined;
    let rejectJob: (reason: unknown) => void = () => undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job: PersistenceJob<Snapshot> = {
      snapshot: queuedSnapshot,
      generation,
      resolve: resolveJob,
      reject: rejectJob,
    };

    if (flush) {
      if (pendingOrdinary) {
        settleSuperseded(pendingOrdinary);
        pendingOrdinary = undefined;
      }
      if (pendingFlush) settleSuperseded(pendingFlush);
      pendingFlush = job;
      // Flush cancels any settle delay and pumps immediately.
      pump();
    } else if (pendingOrdinary) {
      settleSuperseded(pendingOrdinary);
      pendingOrdinary = job;
    } else {
      pendingOrdinary = job;
      scheduleSettlePump();
    }
    return completion;
  };

  return {
    request: (snapshot) => enqueue(snapshot, false),
    flush: (snapshot) => enqueue(snapshot, true),
    close: () => {
      closed = true;
      clearSettleTimer();
      if (pendingOrdinary) {
        settleSuperseded(pendingOrdinary);
        pendingOrdinary = undefined;
      }
      if (pendingFlush) settleSuperseded(pendingFlush);
      pendingFlush = undefined;
    },
  };
}
