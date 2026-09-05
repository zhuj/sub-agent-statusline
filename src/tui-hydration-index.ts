import type { ChildSessionState } from "./state.js";

export interface HydrationTransactionIndex {
  upsert(child: ChildSessionState): void;
  remove(childID: string): void;
  get(childID: string): ChildSessionState | undefined;
  resolveSyntheticTarget(child: ChildSessionState): string | undefined;
  childrenOf(parentID: string): readonly ChildSessionState[];
}

type IDBucket = Set<string>;

function isRealSession(child: ChildSessionState): boolean {
  return child.id.startsWith("ses_");
}

function addToBucket(
  buckets: Map<string, IDBucket>,
  key: string,
  childID: string,
): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = new Set();
    buckets.set(key, bucket);
  }
  bucket.add(childID);
}

function removeFromBucket(
  buckets: Map<string, IDBucket>,
  key: string,
  childID: string,
): void {
  const bucket = buckets.get(key);
  if (!bucket) return;
  bucket.delete(childID);
  if (bucket.size === 0) buckets.delete(key);
}

function onlyChildID(bucket: IDBucket | undefined): string | undefined {
  if (!bucket || bucket.size !== 1) return undefined;
  for (const childID of bucket) return childID;
  return undefined;
}

export function createHydrationTransactionIndex(
  children: readonly ChildSessionState[],
): HydrationTransactionIndex {
  const byID = new Map<string, ChildSessionState>();
  const byParent = new Map<string, IDBucket>();
  const realByParent = new Map<string, IDBucket>();
  const realByParentAndMessage = new Map<
    string,
    Map<string, IDBucket>
  >();

  const addRealMemberships = (child: ChildSessionState): void => {
    if (!isRealSession(child)) return;
    addToBucket(realByParent, child.parentID, child.id);
    if (!child.messageID) return;

    let byMessage = realByParentAndMessage.get(child.parentID);
    if (!byMessage) {
      byMessage = new Map();
      realByParentAndMessage.set(child.parentID, byMessage);
    }
    addToBucket(byMessage, child.messageID, child.id);
  };

  const removeRealMemberships = (child: ChildSessionState): void => {
    if (!isRealSession(child)) return;
    removeFromBucket(realByParent, child.parentID, child.id);
    if (!child.messageID) return;

    const byMessage = realByParentAndMessage.get(child.parentID);
    if (!byMessage) return;
    removeFromBucket(byMessage, child.messageID, child.id);
    if (byMessage.size === 0) {
      realByParentAndMessage.delete(child.parentID);
    }
  };

  const upsert = (child: ChildSessionState): void => {
    const previous = byID.get(child.id);
    if (previous) {
      removeRealMemberships(previous);
      if (previous.parentID !== child.parentID) {
        removeFromBucket(byParent, previous.parentID, previous.id);
      }
    }

    byID.set(child.id, child);
    if (!previous || previous.parentID !== child.parentID) {
      addToBucket(byParent, child.parentID, child.id);
    }
    addRealMemberships(child);
  };

  const remove = (childID: string): void => {
    const child = byID.get(childID);
    if (!child) return;
    byID.delete(childID);
    removeFromBucket(byParent, child.parentID, childID);
    removeRealMemberships(child);
  };

  const childrenOf = (parentID: string): readonly ChildSessionState[] => {
    const bucket = byParent.get(parentID);
    if (!bucket) return [];

    const result: ChildSessionState[] = [];
    for (const childID of bucket) {
      const child = byID.get(childID);
      if (child) result.push(child);
    }
    return result;
  };

  for (const child of children) upsert(child);

  return {
    upsert,
    remove,
    get(childID) {
      return byID.get(childID);
    },
    resolveSyntheticTarget(child) {
      if (child.messageID) {
        const messageMatch = onlyChildID(
          realByParentAndMessage
            .get(child.parentID)
            ?.get(child.messageID),
        );
        if (messageMatch) return messageMatch;
      }
      return onlyChildID(realByParent.get(child.parentID));
    },
    childrenOf,
  };
}
