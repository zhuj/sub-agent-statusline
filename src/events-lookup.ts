import type { ChildSessionState, StatuslineState } from "./state.js";

/**
 * Per-state cache of {@link ChildLookup} instances, keyed by the
 * `StatuslineState` object identity. The TUI produces a fresh state object
 * per accepted event, so each event rebuilds the lookup once; subsequent
 * operations that share the same state (synthetic-target resolution,
 * backfill, reconciliation) reuse the cached lookup instead of scanning
 * `state.children` again. The WeakMap is automatically reclaimed when the
 * state is garbage-collected.
 */
const childLookupCache = new WeakMap<StatuslineState, ChildLookup>();

/**
 * Per-process in-memory index of `state.children` used to answer
 * "which child matches this parent/message/target?" questions in O(1)
 * during event application and hydration. Ephemeral: rebuilt on demand
 * and discarded after the operation that needs it completes.
 */
export type ChildLookup = {
  byID: Map<string, string>;
  byTarget: Map<string, Set<string>>;
  sessionsByParent: Map<string, Set<string>>;
  sessionsByParentMessage: Map<string, Set<string>>;
  sessionLikeByParent: Map<string, Set<string>>;
  syntheticByParent: Map<string, Set<string>>;
  syntheticByParentMessage: Map<string, Set<string>>;
  runningSubtasksByParentMessage: Map<string, Set<string>>;
  runningSubtasksByParent: Map<string, Set<string>>;
  indexedKeys: Map<
    string,
    Array<{ bucket: Map<string, Set<string>>; key: string }>
  >;
};

function lookupKey(parentID: string, messageID: string): string {
  return `${parentID}\u0000${messageID}`;
}

/**
 * Internal: composes the bucket key used by the by-parent-message buckets.
 * Exported for events.ts which builds synthetic-target lookups.
 */
export const childLookupKey = lookupKey;

function addLookupValue(
  bucket: Map<string, Set<string>>,
  key: string | undefined,
  childID: string,
  keys: Array<{ bucket: Map<string, Set<string>>; key: string }>,
): void {
  if (!key) return;
  const values = bucket.get(key) ?? new Set<string>();
  values.add(childID);
  bucket.set(key, values);
  keys.push({ bucket, key });
}

function removeLookupValue(
  bucket: Map<string, Set<string>>,
  key: string,
  childID: string,
): void {
  const values = bucket.get(key);
  if (!values) return;
  values.delete(childID);
  if (values.size === 0) bucket.delete(key);
}

export function createChildLookup(state: StatuslineState): ChildLookup {
  const cached = childLookupCache.get(state);
  if (cached !== undefined) return cached;
  const lookup: ChildLookup = {
    byID: new Map(),
    byTarget: new Map(),
    sessionsByParent: new Map(),
    sessionsByParentMessage: new Map(),
    sessionLikeByParent: new Map(),
    syntheticByParent: new Map(),
    syntheticByParentMessage: new Map(),
    runningSubtasksByParentMessage: new Map(),
    runningSubtasksByParent: new Map(),
    indexedKeys: new Map(),
  };
  for (const child of Object.values(state.children)) {
    refreshChildLookup(lookup, state, child.id);
  }
  childLookupCache.set(state, lookup);
  return lookup;
}

/**
 * Drops any cached {@link ChildLookup} for the given state. Callers that
 * mutate a state object in place (rather than cloning) must invalidate the
 * cache so subsequent lookups do not return a stale index. The
 * `refreshChildLookup` / `setChildTarget` helpers already keep an existing
 * lookup consistent, so this is only needed when the lookup is discarded
 * without per-child refresh.
 */
export function invalidateChildLookup(state: StatuslineState): void {
  childLookupCache.delete(state);
}

export function refreshChildLookup(
  lookup: ChildLookup,
  state: StatuslineState,
  childID: string,
): void {
  const oldKeys = lookup.indexedKeys.get(childID) ?? [];
  for (const indexed of oldKeys) {
    removeLookupValue(indexed.bucket, indexed.key, childID);
  }
  lookup.byID.delete(childID);
  lookup.indexedKeys.delete(childID);

  const child = state.children[childID];
  if (!child) return;
  lookup.byID.set(childID, childID);
  const keys: Array<{
    bucket: Map<string, Set<string>>;
    key: string;
  }> = [];
  const add = (bucket: Map<string, Set<string>>, key: string | undefined) => {
    if (!key) return;
    addLookupValue(bucket, key, childID, keys);
  };
  add(lookup.byTarget, child.targetSessionID);
  const isSession = child.id.startsWith("ses_");
  const isSessionLike = child.source === "session" || isSession;
  const isSynthetic = child.source === "subtask" || child.source === "tool";
  if (isSessionLike) add(lookup.sessionLikeByParent, child.parentID);
  if (isSession) {
    add(lookup.sessionsByParent, child.parentID);
    add(
      lookup.sessionsByParentMessage,
      child.messageID ? lookupKey(child.parentID, child.messageID) : undefined,
    );
  }
  if (isSynthetic) {
    add(lookup.syntheticByParent, child.parentID);
    add(
      lookup.syntheticByParentMessage,
      child.messageID ? lookupKey(child.parentID, child.messageID) : undefined,
    );
  }
  if (child.source === "subtask" && child.status === "running") {
    add(
      lookup.runningSubtasksByParentMessage,
      child.messageID ? lookupKey(child.parentID, child.messageID) : undefined,
    );
    add(lookup.runningSubtasksByParent, child.parentID);
  }
  lookup.indexedKeys.set(childID, keys);
}

/**
 * Updates `state.children[childID].targetSessionID` through a single,
 * consistent path: mutates the value, refreshes the in-memory lookup index
 * for that child, and returns whether the state actually changed. Avoids
 * the foot-gun of writing `child.targetSessionID = …` directly without
 * re-indexing.
 */
export function setChildTarget(
  state: StatuslineState,
  childID: string,
  targetSessionID: string,
  lookup?: ChildLookup,
): boolean {
  const child = state.children[childID];
  if (!child) return false;
  if (child.targetSessionID === targetSessionID) return false;
  child.targetSessionID = targetSessionID;
  if (lookup) refreshChildLookup(lookup, state, childID);
  return true;
}

export function lookupChildren(
  state: StatuslineState,
  lookup: ChildLookup,
  bucket: Map<string, Set<string>>,
  key: string | undefined,
): ChildSessionState[] {
  const ids = key ? bucket.get(key) : undefined;
  if (!ids) return [];
  // Fast path: a single child is the common case (most synthetic targets
  // resolve to one real session). Avoid the spread+filter allocation.
  if (ids.size === 1) {
    const child = state.children[ids.values().next().value as string];
    return child ? [child] : [];
  }
  return [...ids]
    .map((id) => state.children[id])
    .filter((child): child is ChildSessionState => child !== undefined);
}
