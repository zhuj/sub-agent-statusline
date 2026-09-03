export interface RunningReconcileCacheEntry {
  nextAllowedAtMs: number;
  backoffMs: number;
}

export type RunningReconcileVersion = {
  readonly childID: string;
  readonly targetSessionID?: string;
  readonly parentID?: string;
  readonly messageID?: string;
  readonly status: "running" | "done" | "error";
  readonly updatedAt: string;
};

export type RunningReconcileEvidence = {
  status?: "running" | "done" | "error";
  endedAt?: string;
  checkedMessages?: boolean;
  sawRunningEvidence?: boolean;
  probeFailed?: boolean;
  canApplyStaleFallback?: boolean;
};

export type OpenCodeSessionChildStatus = "running" | "done" | "error";

export type SessionMessageSummary = {
  completedAt?: string;
  evidenceAt?: string;
  hasError?: boolean;
  fetchFailed?: boolean;
  latestAssistantActivityAt?: string;
  latestAssistantActivityAtMs?: number;
  latestMessageActivityAt?: string;
  latestMessageActivityAtMs?: number;
};

const DEFAULT_STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 60_000;

const RUNNING_SESSION_STATUS_VALUES = new Set([
  "busy",
  "running",
  "pending",
  "queued",
  "in_progress",
  "working",
  "compacting",
  "retry",
]);

const DONE_SESSION_STATUS_VALUES = new Set([
  "idle",
  "done",
  "completed",
  "complete",
  "success",
  "succeeded",
]);

const ERROR_SESSION_STATUS_VALUES = new Set([
  "error",
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "aborted",
]);

export function defaultStaleRunningThresholdMs(): number {
  return DEFAULT_STALE_RUNNING_THRESHOLD_MS;
}

export function parseStaleRunningThresholdMs(value: unknown): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_STALE_RUNNING_THRESHOLD_MS;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STALE_RUNNING_THRESHOLD_MS;
  }

  return Math.floor(parsed);
}

export function deriveOpenCodeSessionStatus(
  value: unknown,
): OpenCodeSessionChildStatus | undefined {
  if (hasStructuredErrorEvidence(value)) {
    return "error";
  }

  const values = collectOpenCodeSessionStatusValues(value);

  if (values.some((status) => ERROR_SESSION_STATUS_VALUES.has(status))) {
    return "error";
  }

  if (values.some((status) => RUNNING_SESSION_STATUS_VALUES.has(status))) {
    return "running";
  }

  if (values.some((status) => DONE_SESSION_STATUS_VALUES.has(status))) {
    return "done";
  }

  return undefined;
}

export function hasStructuredErrorEvidence(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  const record = asRecord(value);
  if (!record) return false;

  if (record.error) return true;

  for (const nested of Object.values(record)) {
    if (Array.isArray(nested)) {
      if (nested.some((item) => hasStructuredErrorEvidence(item, depth + 1))) {
        return true;
      }
      continue;
    }

    if (hasStructuredErrorEvidence(nested, depth + 1)) return true;
  }

  return false;
}

export function resolveSessionStatusWithMessageSummary(input: {
  status?: OpenCodeSessionChildStatus;
  summary?: SessionMessageSummary;
}): { status?: OpenCodeSessionChildStatus; endedAt?: string } {
  const summary = input.summary;

  if (input.status === "error") {
    return { status: "error", endedAt: summary?.evidenceAt };
  }

  if (input.status === "running") {
    return { status: "running" };
  }

  if (summary && !summary.fetchFailed && summary.hasError) {
    return { status: "error", endedAt: summary.evidenceAt };
  }

  if (input.status === "done") {
    return {
      status: "done",
      endedAt: summary?.completedAt ?? summary?.evidenceAt,
    };
  }

  if (
    summary &&
    !summary.fetchFailed &&
    typeof summary.completedAt === "string"
  ) {
    return { status: "done", endedAt: summary.completedAt };
  }

  return {};
}

export type PersistedStaleSubtaskCandidate = {
  childID: string;
  parentID: string;
  messageID: string;
  title?: string;
  summary?: string;
  agentName?: string;
};

export type PersistedStaleSubtaskResolution = {
  status: "done" | "error";
  endedAt?: string;
  targetSessionID?: string;
};

type PersistedStaleSubtaskMessageContext = {
  readonly message: Record<string, unknown>;
  readonly info: Record<string, unknown>;
  readonly parts: readonly unknown[];
  readonly assistantParentID?: string;
};

type PersistedStaleSubtaskMessageEntry = {
  readonly context: PersistedStaleSubtaskMessageContext;
  readonly part: Record<string, unknown>;
  readonly state: Record<string, unknown>;
  readonly status: "done" | "error";
  readonly targetSessionID?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly agent?: string;
  readonly endedAt?: string;
  readonly order: number;
};

export type PersistedStaleSubtaskMessageIndex = {
  readonly byMessageID: ReadonlyMap<
    string,
    readonly PersistedStaleSubtaskMessageEntry[]
  >;
  readonly byTitle: ReadonlyMap<
    string,
    readonly PersistedStaleSubtaskMessageEntry[]
  >;
  readonly bySummary: ReadonlyMap<
    string,
    readonly PersistedStaleSubtaskMessageEntry[]
  >;
  readonly byAgent: ReadonlyMap<
    string,
    readonly PersistedStaleSubtaskMessageEntry[]
  >;
};

/**
 * Per-process cache of {@link PersistedStaleSubtaskMessageIndex} instances,
 * keyed by the messages array reference. The cache reuses an index for
 * repeated `resolvePersistedStaleSubtaskFromParentMessages` calls against
 * the same message snapshot.
 *
 * Contract: callers MUST treat the messages array as an immutable snapshot
 * for the lifetime of the cached index. Mutating the array in place will
 * leave the cached index stale and the next resolution will return wrong
 * results. In practice, the TUI passes the response of
 * `session.messages(id)` and OpenCode returns a fresh array per call, so
 * the contract holds. If a caller needs to pass a mutable array, they
 * should pass an explicit `index` built from a fresh snapshot.
 */
const staleSubtaskMessageIndexCache = new WeakMap<
  readonly unknown[],
  PersistedStaleSubtaskMessageIndex
>();

export function summarizeSessionMessages(messages: unknown[]): {
  completedAt?: string;
  evidenceAt?: string;
  hasError: boolean;
  latestAssistantActivityAt?: string;
  latestAssistantActivityAtMs?: number;
  latestMessageActivityAt?: string;
  latestMessageActivityAtMs?: number;
} {
  let completedAt: string | undefined;
  let evidenceAt: string | undefined;
  let hasError = false;
  let latestAssistantActivityAt: string | undefined;
  let latestAssistantActivityAtMs: number | undefined;
  let latestMessageActivityAt: string | undefined;
  let latestMessageActivityAtMs: number | undefined;
  let latestTerminalTimeMs: number | undefined;
  let latestEvidenceTimeMs: number | undefined;
  let latestCompletedTimeMs: number | undefined;

  for (const rawMessage of messages) {
    const message = asRecord(rawMessage);
    const info = asRecord(message?.info);
    if (!info) continue;
    const activityMs = messageTimeMillis(info);
    if (
      activityMs > 0 &&
      (latestMessageActivityAtMs === undefined ||
        activityMs > latestMessageActivityAtMs)
    ) {
      latestMessageActivityAtMs = activityMs;
      latestMessageActivityAt = new Date(activityMs).toISOString();
    }

    if (info.role !== "assistant") continue;
    const time = asRecord(info.time);
    if (
      activityMs > 0 &&
      (latestAssistantActivityAtMs === undefined ||
        activityMs > latestAssistantActivityAtMs)
    ) {
      latestAssistantActivityAtMs = activityMs;
      latestAssistantActivityAt = new Date(activityMs).toISOString();
    }
    const candidate = timestampFromUnknown(time?.completed);
    const errorAt =
      timestampFromUnknown(time?.updated) ??
      timestampFromUnknown(time?.completed) ??
      timestampFromUnknown(time?.created);

    if (!info.error && candidate) {
      if (
        latestCompletedTimeMs === undefined ||
        activityMs >= latestCompletedTimeMs
      ) {
        latestCompletedTimeMs = activityMs;
        completedAt = candidate;
      }
    }

    if (!info.error && !candidate) continue;

    if (
      latestTerminalTimeMs === undefined ||
      activityMs >= latestTerminalTimeMs
    ) {
      latestTerminalTimeMs = activityMs;
      hasError = Boolean(info.error);
    }

    const evidence = info.error ? errorAt : candidate;
    if (
      evidence !== undefined &&
      (latestEvidenceTimeMs === undefined ||
        activityMs >= latestEvidenceTimeMs)
    ) {
      latestEvidenceTimeMs = activityMs;
      evidenceAt = evidence;
    }
  }

  return {
    completedAt,
    evidenceAt,
    hasError,
    latestAssistantActivityAt,
    latestAssistantActivityAtMs,
    latestMessageActivityAt,
    latestMessageActivityAtMs,
  };
}

export function hasRecentMessageActivity(input: {
  nowMs: number;
  latestMessageActivityAtMs?: number;
  staleThresholdMs: number;
}): boolean {
  return (
    input.latestMessageActivityAtMs !== undefined &&
    input.nowMs - input.latestMessageActivityAtMs < input.staleThresholdMs
  );
}

export function canSafelyCloseNoTargetPersistedCandidate(input: {
  nowMs: number;
  staleThresholdMs: number;
  startedMs: number;
  updatedMs: number;
  latestMessageActivityAtMs?: number;
}): boolean {
  if (input.staleThresholdMs <= 0) return false;
  if (
    input.startedMs < input.staleThresholdMs ||
    input.updatedMs < input.staleThresholdMs
  ) {
    return false;
  }
  return !hasRecentMessageActivity({
    nowMs: input.nowMs,
    latestMessageActivityAtMs: input.latestMessageActivityAtMs,
    staleThresholdMs: input.staleThresholdMs,
  });
}

export function shouldApplyStaleRunningFallback(input: {
  staleThresholdMs: number;
  evidence: RunningReconcileEvidence;
  startedMs: number;
  updatedMs: number;
}): boolean {
  return (
    input.staleThresholdMs > 0 &&
    input.evidence.canApplyStaleFallback === true &&
    input.evidence.probeFailed !== true &&
    input.startedMs >= input.staleThresholdMs &&
    input.updatedMs >= input.staleThresholdMs
  );
}

export function shouldSkipCandidateForBackoff(
  cache: RunningReconcileCacheEntry | undefined,
  nowMs: number,
): boolean {
  return cache !== undefined && nowMs < cache.nextAllowedAtMs;
}

export function matchesRunningReconcileVersion(
  expected: RunningReconcileVersion,
  current: RunningReconcileVersion | undefined,
): boolean {
  return (
    current?.childID === expected.childID &&
    current.targetSessionID === expected.targetSessionID &&
    current.parentID === expected.parentID &&
    current.messageID === expected.messageID &&
    current.status === expected.status &&
    current.updatedAt === expected.updatedAt
  );
}

export async function awaitCurrentRunningReconcileResult<Result>(input: {
  readonly version: RunningReconcileVersion;
  readonly probe: () => Promise<Result>;
  readonly isLifecycleValid: () => boolean;
  readonly currentVersion: () => RunningReconcileVersion | undefined;
}): Promise<Result | undefined> {
  const result = await input.probe();
  if (!input.isLifecycleValid()) return undefined;
  return matchesRunningReconcileVersion(
    input.version,
    input.currentVersion(),
  )
    ? result
    : undefined;
}

export function sweepRunningReconcileBackoff(
  backoff: Map<string, RunningReconcileCacheEntry>,
  retainedRunningKeys: ReadonlySet<string>,
): number {
  let removed = 0;
  for (const key of backoff.keys()) {
    if (retainedRunningKeys.has(key)) continue;
    backoff.delete(key);
    removed += 1;
  }
  return removed;
}

export function nextBackoffState(input: {
  cache: RunningReconcileCacheEntry | undefined;
  nowMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}): RunningReconcileCacheEntry {
  const nextBackoffMs = input.cache
    ? Math.min(
        input.maxBackoffMs,
        Math.max(input.initialBackoffMs, input.cache.backoffMs * 2),
      )
    : input.initialBackoffMs;
  return {
    backoffMs: nextBackoffMs,
    nextAllowedAtMs: input.nowMs + nextBackoffMs,
  };
}

export function capCandidates<T>(candidates: T[], maxCandidates: number): T[] {
  if (maxCandidates <= 0) return [];
  return candidates.length <= maxCandidates
    ? candidates
    : candidates.slice(0, maxCandidates);
}

/** Builds terminal task lookup buckets while parsing each message once. */
export function buildStaleSubtaskMessageIndex(input: {
  readonly messages: readonly unknown[];
}): PersistedStaleSubtaskMessageIndex {
  const byMessageID = new Map<string, PersistedStaleSubtaskMessageEntry[]>();
  const byTitle = new Map<string, PersistedStaleSubtaskMessageEntry[]>();
  const bySummary = new Map<string, PersistedStaleSubtaskMessageEntry[]>();
  const byAgent = new Map<string, PersistedStaleSubtaskMessageEntry[]>();
  let order = 0;

  for (const rawMessage of input.messages) {
    const message = asRecord(rawMessage);
    const info = asRecord(message?.info);
    if (!message || !info || info.role !== "assistant") continue;

    const assistantParentID = asString(
      info.parentID ?? message.parentID ?? message.parentMessageID,
    );
    const rawParts = message.parts;
    const parts = Array.isArray(rawParts) ? rawParts : [];
    const context = {
      message,
      info,
      parts,
      ...(assistantParentID === undefined ? {} : { assistantParentID }),
    };

    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part || part.type !== "tool" || part.tool !== "task") continue;

      const state = asRecord(part.state);
      const rawStatus = asString(state?.status);
      const status =
        rawStatus === "completed"
          ? "done"
          : rawStatus === "error"
            ? "error"
            : undefined;
      if (!state || !status) continue;

      const taskInput = asRecord(state.input);
      const metadata = asRecord(state.metadata);
      const targetSessionID =
        sessionIDFromUnknown(metadata?.sessionId) ??
        sessionIDFromUnknown(metadata?.sessionID) ??
        parseTaskSessionIDFromOutput(state.output);
      const title =
        asString(taskInput?.description) ??
        asString(state.title) ??
        asString(part.description);
      const summary =
        asString(taskInput?.prompt) ?? asString(state.description);
      const agent =
        asString(taskInput?.subagent_type) ?? asString(part.agent);
      const stateTime = asRecord(state.time);
      const infoTime = asRecord(info.time);
      const endedAt =
        timestampFromUnknown(
          stateTime?.end ?? stateTime?.completed ?? stateTime?.updated,
        ) ??
        timestampFromUnknown(
          infoTime?.completed ?? infoTime?.updated ?? infoTime?.created,
        );
      const entry: PersistedStaleSubtaskMessageEntry = {
        context,
        part,
        state,
        status,
        ...(targetSessionID === undefined ? {} : { targetSessionID }),
        ...(title === undefined ? {} : { title }),
        ...(summary === undefined ? {} : { summary }),
        ...(agent === undefined ? {} : { agent }),
        ...(endedAt === undefined ? {} : { endedAt }),
        order: order++,
      };

      addStaleSubtaskIndexEntry(
        byMessageID,
        assistantParentID,
        entry,
      );
      addStaleSubtaskIndexEntry(
        byTitle,
        staleSubtaskDisplayTextKey(title),
        entry,
      );
      addStaleSubtaskIndexEntry(
        bySummary,
        staleSubtaskDisplayTextKey(summary),
        entry,
      );
      addStaleSubtaskIndexEntry(
        byAgent,
        staleSubtaskDisplayTextKey(agent),
        entry,
      );
    }
  }

  return { byMessageID, byTitle, bySummary, byAgent };
}

function addStaleSubtaskIndexEntry(
  buckets: Map<string, PersistedStaleSubtaskMessageEntry[]>,
  key: string | undefined,
  entry: PersistedStaleSubtaskMessageEntry,
): void {
  if (key === undefined) return;
  const bucket = buckets.get(key);
  if (bucket === undefined) {
    buckets.set(key, [entry]);
    return;
  }
  bucket.push(entry);
}

function staleSubtaskDisplayTextKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().toLowerCase();
}

function getStaleSubtaskMessageIndex(
  messages: readonly unknown[],
): PersistedStaleSubtaskMessageIndex {
  const cached = staleSubtaskMessageIndexCache.get(messages);
  if (cached !== undefined) return cached;
  const index = buildStaleSubtaskMessageIndex({ messages });
  staleSubtaskMessageIndexCache.set(messages, index);
  return index;
}

function matchingStaleSubtaskEntries(
  index: PersistedStaleSubtaskMessageIndex,
  candidate: PersistedStaleSubtaskCandidate,
): PersistedStaleSubtaskMessageEntry[] {
  const buckets: readonly (readonly PersistedStaleSubtaskMessageEntry[])[] = [
    index.byMessageID.get(candidate.messageID) ?? [],
  ];
  const titleKey = staleSubtaskDisplayTextKey(candidate.title);
  const summaryKey = staleSubtaskDisplayTextKey(candidate.summary);
  const agentKey = staleSubtaskDisplayTextKey(candidate.agentName);
  const matchingBuckets = [
    ...buckets,
    ...(titleKey === undefined ? [] : [index.byTitle.get(titleKey) ?? []]),
    ...(summaryKey === undefined ? [] : [index.bySummary.get(summaryKey) ?? []]),
    ...(agentKey === undefined ? [] : [index.byAgent.get(agentKey) ?? []]),
  ];
  const offsets = matchingBuckets.map(() => 0);
  const entries: PersistedStaleSubtaskMessageEntry[] = [];

  while (true) {
    let nextEntry: PersistedStaleSubtaskMessageEntry | undefined;
    for (let bucketIndex = 0; bucketIndex < matchingBuckets.length; bucketIndex += 1) {
      const bucket = matchingBuckets[bucketIndex];
      const offset = offsets[bucketIndex];
      const entry = bucket?.[offset];
      if (entry !== undefined && (nextEntry === undefined || entry.order < nextEntry.order)) {
        nextEntry = entry;
      }
    }
    if (nextEntry === undefined) break;

    entries.push(nextEntry);
    for (let bucketIndex = 0; bucketIndex < matchingBuckets.length; bucketIndex += 1) {
      const bucket = matchingBuckets[bucketIndex];
      while (bucket?.[offsets[bucketIndex]]?.order === nextEntry.order) {
        offsets[bucketIndex] += 1;
      }
    }
  }

  return entries;
}

/** Resolves one persisted candidate from a shared or lazily cached message index. */
export function resolvePersistedStaleSubtaskFromParentMessages(input: {
  candidate: PersistedStaleSubtaskCandidate;
  messages: unknown[];
  readonly index?: PersistedStaleSubtaskMessageIndex;
}): PersistedStaleSubtaskResolution | undefined {
  let bestMatch: PersistedStaleSubtaskResolution | undefined;
  let bestScore: number | undefined;
  let secondBestScore: number | undefined;

  const index = input.index ?? getStaleSubtaskMessageIndex(input.messages);
  for (const entry of matchingStaleSubtaskEntries(index, input.candidate)) {
    const parentMessageMatch =
      entry.context.assistantParentID !== undefined &&
      entry.context.assistantParentID === input.candidate.messageID;
    const titleMatch = sameDisplayText(entry.title, input.candidate.title);
    const summaryMatch = sameDisplayText(
      entry.summary,
      input.candidate.summary,
    );
    const agentMatch = sameDisplayText(entry.agent, input.candidate.agentName);

    const metadataCompositeMatch =
      summaryMatch || (titleMatch && agentMatch && !!input.candidate.summary);
    if (!parentMessageMatch && !metadataCompositeMatch) continue;

    const score =
      (parentMessageMatch ? 100 : 0) +
      (summaryMatch ? 40 : 0) +
      (titleMatch ? 20 : 0) +
      (agentMatch ? 10 : 0);

    const resolution = {
      status: entry.status,
      endedAt: entry.endedAt,
      targetSessionID: entry.targetSessionID,
    };

    if (bestScore === undefined || score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestMatch = resolution;
    } else if (secondBestScore === undefined || score > secondBestScore) {
      secondBestScore = score;
    }
  }

  if (bestMatch === undefined || bestScore === secondBestScore) {
    return undefined;
  }
  return bestMatch;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectOpenCodeSessionStatusValues(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = normalizeStatusValue(value);
    return normalized ? [normalized] : [];
  }

  const record = asRecord(value);
  if (!record) return [];

  const values = [
    normalizeStatusValue(record.type),
    normalizeStatusValue(record.status),
    normalizeStatusValue(record.state),
    normalizeStatusValue(record.phase),
    normalizeStatusValue(record.result),
  ].filter((status): status is string => Boolean(status));

  if (record.error) values.push("error");
  if (record.busy === true || record.running === true) values.push("busy");

  return values;
}

function normalizeStatusValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameDisplayText(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sessionIDFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("ses_")
    ? value
    : undefined;
}

function parseTaskSessionIDFromOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\b(?:task_id\s*:\s*)?(ses_[A-Za-z0-9_-]+)\b/i);
  if (!match) return undefined;
  return match[1];
}

function messageTimeMillis(info: Record<string, unknown> | undefined): number {
  const time = asRecord(info?.time);
  return (
    timestampMillisFromUnknown(time?.completed) ??
    timestampMillisFromUnknown(time?.updated) ??
    timestampMillisFromUnknown(time?.created) ??
    0
  );
}

function timestampFromUnknown(value: unknown): string | undefined {
  const millis = timestampMillisFromUnknown(value);
  return millis === undefined ? undefined : new Date(millis).toISOString();
}

function timestampMillisFromUnknown(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : millis;
  }
  return undefined;
}
