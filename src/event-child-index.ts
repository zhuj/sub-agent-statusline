import type { ChildSessionState } from "./state.js";

export type SyntheticTargetKey = {
  readonly parentID: string;
  readonly messageID?: string;
};

export interface EventChildIndex {
  upsert(child: ChildSessionState): void;
  remove(id: string): void;
  resolveSyntheticTarget(
    synthetic: SyntheticTargetKey,
    explicitCandidates: readonly string[],
  ): string | undefined;
  runningSubtasks(parentID: string): readonly ChildSessionState[];
  targetlessSynthetic(parentID: string): readonly ChildSessionState[];
  realSessionSiblings(parentID: string): readonly ChildSessionState[];
}

type IDSet = Set<string>;

function isSessionID(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("ses_");
}

function isTargetlessSynthetic(child: ChildSessionState): boolean {
  return (
    (child.source === "tool" || child.source === "subtask") &&
    !child.targetSessionID
  );
}

function isRunningSubtask(child: ChildSessionState): boolean {
  return child.source === "subtask" && child.status === "running";
}

function isRealSessionSibling(child: ChildSessionState): boolean {
  return child.source === "session" || child.id.startsWith("ses_");
}

function isSessionEvidence(child: ChildSessionState): boolean {
  return child.id.startsWith("ses_");
}

export function createEventChildIndex(
  children: readonly ChildSessionState[],
): EventChildIndex {
  const byID = new Map<string, ChildSessionState>();
  const runningSubtasksByParent = new Map<string, IDSet>();
  const targetlessByParent = new Map<string, IDSet>();
  const realSiblingsByParent = new Map<string, IDSet>();
  const sesByParent = new Map<string, IDSet>();
  const sesByParentAndMessage = new Map<string, Map<string, IDSet>>();

  const removeFromBucket = (
    map: Map<string, IDSet>,
    key: string,
    id: string,
  ): void => {
    const bucket = map.get(key);
    if (!bucket) return;
    bucket.delete(id);
    if (bucket.size === 0) map.delete(key);
  };

  const addToBucket = (
    map: Map<string, IDSet>,
    key: string,
    id: string,
  ): void => {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new Set();
      map.set(key, bucket);
    }
    bucket.add(id);
  };

  const removeMemberships = (child: ChildSessionState): void => {
    if (isRunningSubtask(child)) {
      removeFromBucket(runningSubtasksByParent, child.parentID, child.id);
    }
    if (isTargetlessSynthetic(child)) {
      removeFromBucket(targetlessByParent, child.parentID, child.id);
    }
    if (isRealSessionSibling(child)) {
      removeFromBucket(realSiblingsByParent, child.parentID, child.id);
    }
    if (isSessionEvidence(child)) {
      removeFromBucket(sesByParent, child.parentID, child.id);
      if (child.messageID) {
        const byMessage = sesByParentAndMessage.get(child.parentID);
        if (byMessage) {
          removeFromBucket(byMessage, child.messageID, child.id);
          if (byMessage.size === 0) {
            sesByParentAndMessage.delete(child.parentID);
          }
        }
      }
    }
  };

  const addMemberships = (child: ChildSessionState): void => {
    if (isRunningSubtask(child)) {
      addToBucket(runningSubtasksByParent, child.parentID, child.id);
    }
    if (isTargetlessSynthetic(child)) {
      addToBucket(targetlessByParent, child.parentID, child.id);
    }
    if (isRealSessionSibling(child)) {
      addToBucket(realSiblingsByParent, child.parentID, child.id);
    }
    if (isSessionEvidence(child)) {
      addToBucket(sesByParent, child.parentID, child.id);
      if (child.messageID) {
        let byMessage = sesByParentAndMessage.get(child.parentID);
        if (!byMessage) {
          byMessage = new Map();
          sesByParentAndMessage.set(child.parentID, byMessage);
        }
        addToBucket(byMessage, child.messageID, child.id);
      }
    }
  };

  const upsert = (child: ChildSessionState): void => {
    const previous = byID.get(child.id);
    byID.set(child.id, child);
    if (previous) removeMemberships(previous);
    addMemberships(child);
  };

  const remove = (id: string): void => {
    const child = byID.get(id);
    if (!child) return;
    byID.delete(id);
    removeMemberships(child);
  };

  const snapshotChildren = (
    bucket: IDSet | undefined,
  ): readonly ChildSessionState[] => {
    if (!bucket) return [];
    const result: ChildSessionState[] = [];
    for (const id of bucket) {
      const child = byID.get(id);
      if (child) result.push(child);
    }
    return result;
  };

  for (const child of children) upsert(child);

  return {
    upsert,
    remove,
    resolveSyntheticTarget(synthetic, explicitCandidates) {
      const candidates = new Set<string>();
      for (const candidate of explicitCandidates) {
        if (isSessionID(candidate)) candidates.add(candidate);
      }

      if (synthetic.messageID) {
        const byMessage = sesByParentAndMessage
          .get(synthetic.parentID)
          ?.get(synthetic.messageID);
        if (byMessage && byMessage.size === 1) {
          for (const id of byMessage) candidates.add(id);
        }
      }

      const byParent = sesByParent.get(synthetic.parentID);
      if (byParent && byParent.size === 1) {
        for (const id of byParent) candidates.add(id);
      }

      if (candidates.size !== 1) return undefined;
      for (const id of candidates) return id;
      return undefined;
    },
    runningSubtasks(parentID) {
      return snapshotChildren(runningSubtasksByParent.get(parentID));
    },
    targetlessSynthetic(parentID) {
      return snapshotChildren(targetlessByParent.get(parentID));
    },
    realSessionSiblings(parentID) {
      return snapshotChildren(realSiblingsByParent.get(parentID));
    },
  };
}
