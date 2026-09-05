import { byPriority, projectCorrelatedSubagentWorkItems } from "./render.js";
import type { ChildSessionState } from "./state.js";
import {
  buildCorrelationIndex,
  correlateSubagentWorkItems,
  resolveCorrelatedExecutionIDFromIndex,
} from "./subagent-classification.js";

export type RunningReconcileCandidate = {
  readonly childID: string;
  readonly targetSessionID?: string;
  readonly parentID: string;
  readonly messageID?: string;
  readonly source?: ChildSessionState["source"];
  readonly title: string;
  readonly summary?: string;
  readonly agentName?: string;
  readonly startedMs: number;
  readonly updatedMs: number;
};

export type SelectRunningReconcileCandidatesInput = {
  readonly children: readonly ChildSessionState[];
  readonly currentSessionID?: string;
  readonly nowMs: number;
  readonly maxCandidates: number;
  readonly excludedTargetIDs?: ReadonlySet<string>;
  readonly oldCandidateAgeMs: number;
};

type PrioritizedCandidate = {
  readonly child: ChildSessionState;
  readonly candidate: RunningReconcileCandidate;
};

function ageMillis(timestamp: string, nowMs: number): number {
  const timestampMs = Date.parse(timestamp);
  return Number.isNaN(timestampMs) ? 0 : Math.max(0, nowMs - timestampMs);
}

function isOldCandidate(
  child: ChildSessionState,
  nowMs: number,
  oldCandidateAgeMs: number,
): boolean {
  return (
    ageMillis(child.startedAt, nowMs) >= oldCandidateAgeMs ||
    ageMillis(child.updatedAt, nowMs) >= oldCandidateAgeMs
  );
}

function directTargetSessionID(child: ChildSessionState): string | undefined {
  if (child.targetSessionID?.startsWith("ses_")) return child.targetSessionID;
  return child.id.startsWith("ses_") ? child.id : undefined;
}

export function descendantIDsFromChildren(
  children: readonly ChildSessionState[],
  rootID: string | undefined,
): ReadonlySet<string> {
  const descendants = new Set<string>();
  if (!rootID) return descendants;
  const byParent = new Map<string, string[]>();
  for (const child of children) {
    const siblings = byParent.get(child.parentID);
    if (siblings) siblings.push(child.id);
    else byParent.set(child.parentID, [child.id]);
  }
  const visited = new Set([rootID]);
  const pending = [rootID];
  while (pending.length > 0) {
    const parentID = pending.pop();
    if (parentID === undefined) continue;
    for (const id of byParent.get(parentID) ?? []) {
      if (visited.has(id)) continue;
      visited.add(id);
      descendants.add(id);
      pending.push(id);
    }
  }
  return descendants;
}

function toCandidate(
  child: ChildSessionState,
  targetSessionID: string | undefined,
  nowMs: number,
): RunningReconcileCandidate {
  return {
    childID: child.id,
    targetSessionID,
    parentID: child.parentID,
    messageID: child.messageID,
    source: child.source,
    title: child.title,
    summary: child.summary,
    agentName: child.agentName,
    startedMs: ageMillis(child.startedAt, nowMs),
    updatedMs: ageMillis(child.updatedAt, nowMs),
  };
}

function insertBoundedByPriority(
  selected: PrioritizedCandidate[],
  item: PrioritizedCandidate,
  maxCandidates: number,
): void {
  let index = 0;
  while (
    index < selected.length &&
    byPriority(selected[index]?.child ?? item.child, item.child) <= 0
  ) {
    index += 1;
  }
  if (index >= maxCandidates) return;
  selected.splice(index, 0, item);
  if (selected.length > maxCandidates) selected.pop();
}

export function createRunningReconcileSelector() {
  const visited = new Set<string>();
  return (input: SelectRunningReconcileCandidatesInput): RunningReconcileCandidate[] => {
    const present = new Set<string>();
    for (const child of input.children) {
      present.add(child.id);
      if (child.targetSessionID !== undefined) present.add(child.targetSessionID);
    }
    for (const key of visited) {
      if (!present.has(key)) visited.delete(key);
    }
    const excluded = new Set(input.excludedTargetIDs ?? []);
    for (const key of visited) excluded.add(key);
    let result = selectRunningReconcileCandidates({ ...input, excludedTargetIDs: excluded });
    if (result.length === 0 && visited.size > 0) {
      visited.clear();
      result = selectRunningReconcileCandidates(input);
    }
    for (const candidate of result) visited.add(candidate.targetSessionID ?? candidate.childID);
    return result;
  };
}

export function selectRunningReconcileCandidates(
  input: SelectRunningReconcileCandidatesInput,
): RunningReconcileCandidate[] {
  if (input.maxCandidates <= 0) return [];

  const runningChildren = input.children.filter(
    (child) => child.status === "running",
  );
  if (runningChildren.length === 0) return [];

  const descendantIDs = descendantIDsFromChildren(input.children, input.currentSessionID);

  const projected = projectCorrelatedSubagentWorkItems(
    correlateSubagentWorkItems(runningChildren),
  );
  const realChildren = input.children
    .filter((child) => child.id.startsWith("ses_"))
    .map((child) => ({ ...child, targetSessionID: child.id }));
  const targetIndex = buildCorrelationIndex(realChildren);
  const resolveTarget = (child: ChildSessionState): string | undefined =>
    directTargetSessionID(child) ??
    resolveCorrelatedExecutionIDFromIndex(child, targetIndex);
  const eligibleCandidate = (
    child: ChildSessionState,
  ): RunningReconcileCandidate | undefined => {
    const targetSessionID = resolveTarget(child);
    if (input.excludedTargetIDs?.has(targetSessionID ?? child.id)) return undefined;
    const canProbePersistedSubtask =
      child.source === "subtask" &&
      !targetSessionID &&
      child.parentID.length > 0 &&
      typeof child.messageID === "string" &&
      child.messageID.length > 0 &&
      isOldCandidate(child, input.nowMs, input.oldCandidateAgeMs);
    return targetSessionID || canProbePersistedSubtask
      ? toCandidate(child, targetSessionID, input.nowMs)
      : undefined;
  };

  const prioritized: PrioritizedCandidate[] = [];
  for (const child of projected) {
    if (
      input.currentSessionID &&
      !descendantIDs.has(child.id)
    ) {
      continue;
    }
    const candidate = eligibleCandidate(child);
    if (!candidate) continue;
    insertBoundedByPriority(
      prioritized,
      { child, candidate },
      input.maxCandidates,
    );
  }

  const selected = prioritized.map((item) => item.candidate);
  const seenChildIDs = new Set(selected.map((candidate) => candidate.childID));
  for (const child of runningChildren) {
    if (selected.length >= input.maxCandidates) break;
    if (
      seenChildIDs.has(child.id) ||
      !isOldCandidate(child, input.nowMs, input.oldCandidateAgeMs)
    ) {
      continue;
    }
    seenChildIDs.add(child.id);
    const candidate = eligibleCandidate(child);
    if (!candidate) continue;
    selected.push(candidate);
  }

  return selected;
}
