import type { ChildSessionState } from "./state.js";
import { childLookupKey } from "./events-lookup.js";

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

// Internal one-pass immutable correlation index (ephemeral, not persisted).
// Built once per operation; replaces repeated per-proxy filtering over real items.
interface SubagentCorrelationIndex<T extends SubagentClassifiableWorkItem> {
  // All real execution items in first-occurrence input order.
  realItemsOrdered: T[];
  // First real item per execution ID (first insertion wins; preserves order).
  firstRealByExecutionID: Map<string, T>;
  // Complete set of unique real execution IDs for trusted-target lookup.
  executionIDSet: Set<string>;
  // Parent/message composite -> matching real items in input order.
  parentMessageRealItems: Map<string, T[]>;
  // Parent -> matching real items in input order.
  parentRealItems: Map<string, T[]>;
  // Uniqueness/ambiguity tracking derived from the buckets above.
  parentMessageExecutionSets: Map<string, Set<string>>;
  parentExecutionSets: Map<string, Set<string>>;
}

function buildSubagentCorrelationIndex<T extends SubagentClassifiableWorkItem>(
  items: readonly T[],
): SubagentCorrelationIndex<T> {
  const realItemsOrdered: T[] = [];
  const firstRealByExecutionID = new Map<string, T>();
  const executionIDSet = new Set<string>();
  const parentMessageRealItems = new Map<string, T[]>();
  const parentRealItems = new Map<string, T[]>();
  const parentMessageExecutionSets = new Map<string, Set<string>>();
  const parentExecutionSets = new Map<string, Set<string>>();

  for (const item of items) {
    if (!isRealExecution(item)) continue;
    const executionID = realExecutionID(item);
    realItemsOrdered.push(item);
    executionIDSet.add(executionID);
    if (!firstRealByExecutionID.has(executionID)) {
      firstRealByExecutionID.set(executionID, item);
    }

    const pmKey = item.messageID
      ? childLookupKey(item.parentID, item.messageID)
      : undefined;
    if (pmKey) {
      const pmBucket = parentMessageRealItems.get(pmKey) ?? [];
      pmBucket.push(item);
      parentMessageRealItems.set(pmKey, pmBucket);

      const pmSet = parentMessageExecutionSets.get(pmKey) ?? new Set<string>();
      pmSet.add(executionID);
      parentMessageExecutionSets.set(pmKey, pmSet);
    }

    const pBucket = parentRealItems.get(item.parentID) ?? [];
    pBucket.push(item);
    parentRealItems.set(item.parentID, pBucket);

    const pSet = parentExecutionSets.get(item.parentID) ?? new Set<string>();
    pSet.add(executionID);
    parentExecutionSets.set(item.parentID, pSet);
  }

  return {
    realItemsOrdered,
    firstRealByExecutionID,
    executionIDSet,
    parentMessageRealItems,
    parentRealItems,
    parentMessageExecutionSets,
    parentExecutionSets,
  };
}

function uniqueExecutionID<T extends SubagentClassifiableWorkItem>(
  candidates: readonly T[],
): string | undefined {
  const executionIDs = new Set(candidates.map((item) => realExecutionID(item)));
  return executionIDs.size === 1 ? [...executionIDs][0] : undefined;
}

function realExecutions<T extends SubagentClassifiableWorkItem>(
  items: readonly T[],
): T[] {
  return items.filter((item) => classifySubagentWorkItem(item).kind === "real-execution");
}

export function resolveTrustedTargetExecutionID<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, realItems: readonly T[]): string | undefined {
  const targetSessionID = trustedTargetSessionID(item);
  if (!targetSessionID) return undefined;

  return realExecutions(realItems).some(
    (realItem) => realExecutionID(realItem) === targetSessionID,
  )
    ? targetSessionID
    : undefined;
}

export function resolveSharedMessageExecutionID<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, realItems: readonly T[]): string | undefined {
  if (!item.messageID) return undefined;

  return uniqueExecutionID(
    realExecutions(realItems).filter(
      (realItem) =>
        realItem.parentID === item.parentID &&
        realItem.messageID === item.messageID,
    ),
  );
}

export function resolveUniqueSameParentExecutionID<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, realItems: readonly T[]): string | undefined {
  return uniqueExecutionID(
    realExecutions(realItems).filter(
      (realItem) => realItem.parentID === item.parentID,
    ),
  );
}

function resolveCorrelatedExecutionIDWithIndex<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, index: SubagentCorrelationIndex<T>): string | undefined {
  const targetSessionID = trustedTargetSessionID(item);
  if (targetSessionID) {
    return index.executionIDSet.has(targetSessionID) ? targetSessionID : undefined;
  }

  if (item.messageID) {
    const pmKey = childLookupKey(item.parentID, item.messageID);
    const pmSet = index.parentMessageExecutionSets.get(pmKey);
    if (pmSet && pmSet.size === 1) {
      return [...pmSet][0];
    }
  }

  const pSet = index.parentExecutionSets.get(item.parentID);
  if (pSet && pSet.size === 1) {
    return [...pSet][0];
  }

  return undefined;
}

export function resolveCorrelatedExecutionID<
  T extends SubagentClassifiableWorkItem,
>(item: SubagentClassifiableWorkItem, realItems: readonly T[]): string | undefined {
  if (trustedTargetSessionID(item)) {
    return resolveTrustedTargetExecutionID(item, realItems);
  }

  return (
    resolveSharedMessageExecutionID(item, realItems) ??
    resolveUniqueSameParentExecutionID(item, realItems)
  );
}

export function correlateSubagentWorkItems<
  T extends SubagentClassifiableWorkItem,
>(items: readonly T[]): CorrelatedSubagentExecution<T>[] {
  const index = buildSubagentCorrelationIndex(items);
  const executions = new Map<string, CorrelatedSubagentExecution<T>>();

  for (const item of index.realItemsOrdered) {
    const executionID = realExecutionID(item);
    if (!executions.has(executionID)) {
      executions.set(executionID, { executionID, real: item, proxies: [] });
    }
  }

  for (const item of items) {
    if (classifySubagentWorkItem(item).kind === "real-execution") continue;

    const executionID = resolveCorrelatedExecutionIDWithIndex(item, index);
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
