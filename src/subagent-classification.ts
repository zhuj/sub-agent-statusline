import type { ChildSessionState } from "./state.js";

export type SubagentClassifiableWorkItem = Pick<
  ChildSessionState,
  "id" | "parentID"
> &
  Partial<
    Pick<
      ChildSessionState,
      | "title"
      | "summary"
      | "agentName"
      | "messageID"
      | "source"
      | "toolName"
      | "targetSessionID"
    >
  >;

export type SubagentWorkClassification =
  | { kind: "real-execution"; executionID: string; targetSessionID: string }
  | { kind: "execution-proxy"; executionID: string; targetSessionID: string }
  | { kind: "invocation-wrapper" };

export interface CorrelatedSubagentExecution<
  T extends SubagentClassifiableWorkItem = SubagentClassifiableWorkItem,
> {
  executionID: string;
  real: T;
  proxies: T[];
}

export type CorrelationCandidate = {
  readonly executionID: string;
  readonly ambiguous: boolean;
};

export type CorrelationIndex<T extends SubagentClassifiableWorkItem> = {
  readonly firstRealByExecutionID: ReadonlyMap<string, T>;
  readonly byParentAndMessage: ReadonlyMap<
    string,
    ReadonlyMap<string, CorrelationCandidate>
  >;
  readonly byParent: ReadonlyMap<string, CorrelationCandidate>;
};

export function isRealSessionID(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("ses_");
}

export function isTrustedTargetSessionID(
  value: string | undefined,
): value is string {
  return isRealSessionID(value);
}

export function trustedTargetSessionID(
  item: Partial<Pick<ChildSessionState, "targetSessionID">>,
): string | undefined {
  return isTrustedTargetSessionID(item.targetSessionID)
    ? item.targetSessionID
    : undefined;
}

function isRealExecution(item: SubagentClassifiableWorkItem): boolean {
  return item.source === "session" || isRealSessionID(item.id);
}

function realExecutionID(item: SubagentClassifiableWorkItem): string {
  return trustedTargetSessionID(item) ?? item.id;
}

export function classifySubagentWorkItem(
  item: SubagentClassifiableWorkItem,
): SubagentWorkClassification {
  if (isRealExecution(item)) {
    const executionID = realExecutionID(item);
    return {
      kind: "real-execution",
      executionID,
      targetSessionID: executionID,
    };
  }

  const targetSessionID = trustedTargetSessionID(item);
  if (targetSessionID) {
    return {
      kind: "execution-proxy",
      executionID: targetSessionID,
      targetSessionID,
    };
  }

  return { kind: "invocation-wrapper" };
}

function realExecutions<T extends SubagentClassifiableWorkItem>(
  items: readonly T[],
): T[] {
  return items.filter((item) => classifySubagentWorkItem(item).kind === "real-execution");
}

function addCorrelationCandidate(
  candidates: Map<string, CorrelationCandidate>,
  key: string,
  executionID: string,
): void {
  const existing = candidates.get(key);
  if (!existing) {
    candidates.set(key, { executionID, ambiguous: false });
    return;
  }
  if (existing.executionID !== executionID && !existing.ambiguous) {
    candidates.set(key, { executionID: existing.executionID, ambiguous: true });
  }
}

function resolvedCandidate(
  candidate: CorrelationCandidate | undefined,
): string | undefined {
  return candidate && !candidate.ambiguous ? candidate.executionID : undefined;
}

export function buildCorrelationIndex<T extends SubagentClassifiableWorkItem>(
  realItems: readonly T[],
): CorrelationIndex<T> {
  const firstRealByExecutionID = new Map<string, T>();
  const byParentAndMessage = new Map<
    string,
    Map<string, CorrelationCandidate>
  >();
  const byParent = new Map<string, CorrelationCandidate>();

  for (const realItem of realItems) {
    const executionID = realExecutionID(realItem);
    if (!firstRealByExecutionID.has(executionID)) {
      firstRealByExecutionID.set(executionID, realItem);
    }
    addCorrelationCandidate(byParent, realItem.parentID, executionID);

    if (realItem.messageID) {
      let byMessage = byParentAndMessage.get(realItem.parentID);
      if (!byMessage) {
        byMessage = new Map<string, CorrelationCandidate>();
        byParentAndMessage.set(realItem.parentID, byMessage);
      }
      addCorrelationCandidate(byMessage, realItem.messageID, executionID);
    }
  }

  return { firstRealByExecutionID, byParentAndMessage, byParent };
}

export function resolveCorrelatedExecutionIDFromIndex<
  T extends SubagentClassifiableWorkItem,
>(
  item: SubagentClassifiableWorkItem,
  index: CorrelationIndex<T>,
): string | undefined {
  const targetSessionID = trustedTargetSessionID(item);
  if (targetSessionID) {
    return index.firstRealByExecutionID.has(targetSessionID)
      ? targetSessionID
      : undefined;
  }

  if (item.messageID) {
    const sharedMessageCandidate = index.byParentAndMessage
      .get(item.parentID)
      ?.get(item.messageID);
    if (sharedMessageCandidate) {
      return resolvedCandidate(sharedMessageCandidate);
    }
  }

  return resolvedCandidate(index.byParent.get(item.parentID));
}

export function resolveTrustedTargetExecutionID<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, realItems: readonly T[]): string | undefined {
  const targetSessionID = trustedTargetSessionID(item);
  if (!targetSessionID) return undefined;

  return buildCorrelationIndex(realExecutions(realItems)).firstRealByExecutionID.has(
    targetSessionID,
  )
    ? targetSessionID
    : undefined;
}

export function resolveSharedMessageExecutionID<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, realItems: readonly T[]): string | undefined {
  if (!item.messageID) return undefined;

  const index = buildCorrelationIndex(realExecutions(realItems));
  return resolvedCandidate(
    index.byParentAndMessage.get(item.parentID)?.get(item.messageID),
  );
}

export function resolveUniqueSameParentExecutionID<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, realItems: readonly T[]): string | undefined {
  return resolvedCandidate(
    buildCorrelationIndex(realExecutions(realItems)).byParent.get(item.parentID),
  );
}

export function resolveCorrelatedExecutionID<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, realItems: readonly T[]): string | undefined {
  return resolveCorrelatedExecutionIDFromIndex(
    item,
    buildCorrelationIndex(realExecutions(realItems)),
  );
}

export function correlateSubagentWorkItems<
  T extends SubagentClassifiableWorkItem,
>(items: readonly T[]): CorrelatedSubagentExecution<T>[] {
  const realItems = realExecutions(items);
  const index = buildCorrelationIndex(realItems);
  const executions = new Map<string, CorrelatedSubagentExecution<T>>();

  for (const [executionID, real] of index.firstRealByExecutionID) {
    executions.set(executionID, { executionID, real, proxies: [] });
  }

  for (const item of items) {
    if (classifySubagentWorkItem(item).kind === "real-execution") continue;

    const executionID = resolveCorrelatedExecutionIDFromIndex(item, index);
    if (!executionID) continue;

    executions.get(executionID)?.proxies.push(item);
  }

  return [...executions.values()];
}

export function mergeProxyMetadataWithRealExecution(
  real: ChildSessionState,
  proxy: Partial<Pick<ChildSessionState, "title" | "summary" | "agentName" | "messageID">>,
): ChildSessionState {
  const executionID = realExecutionID(real);

  return {
    ...real,
    title: proxy.title ?? real.title,
    summary: proxy.summary ?? real.summary,
    agentName: proxy.agentName ?? real.agentName,
    messageID: real.messageID ?? proxy.messageID,
    id: real.id,
    parentID: real.parentID,
    source: "session",
    targetSessionID: real.targetSessionID ?? executionID,
    status: real.status,
    color: real.color,
    startedAt: real.startedAt,
    updatedAt: real.updatedAt,
    endedAt: real.endedAt,
    elapsedMs: real.elapsedMs,
    tokens: real.tokens,
    model: real.model,
  };
}
