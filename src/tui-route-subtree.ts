import {
  getSubagentLineageIndex,
  projectSubagentSubtree,
  type SubagentLineageIndex,
  type SubagentSubtreeProjection,
} from "./projection.js";
import { byPriority } from "./render.js";
import type { StatuslineState } from "./state.js";

export interface CurrentRouteSubtreeProjection {
  readonly state: StatuslineState;
  readonly sessionID: string;
  readonly subtree: SubagentSubtreeProjection;
}

type CurrentRouteSubtreeBuilder = (
  state: StatuslineState,
  sessionID: string,
) => CurrentRouteSubtreeProjection;

/**
 * Per-lineage-index cache of subtree projections keyed by rootSessionID.
 * `getSubagentLineageIndex(state)` is itself a `WeakMap`-cached factory, so
 * this cache effectively keys on `(state, rootSessionID)`. Reclaimed
 * automatically when the lineage index is GC'd.
 */
const subtreeProjectionCache = new WeakMap<
  SubagentLineageIndex,
  Map<string, SubagentSubtreeProjection>
>();

function projectSubagentSubtreeCached(
  index: SubagentLineageIndex,
  rootSessionID: string,
): SubagentSubtreeProjection {
  let perRoot = subtreeProjectionCache.get(index);
  if (!perRoot) {
    perRoot = new Map();
    subtreeProjectionCache.set(index, perRoot);
  }
  const cached = perRoot.get(rootSessionID);
  if (cached) return cached;
  const projection = projectSubagentSubtree({
    index,
    rootSessionID,
    compareSiblings: byPriority,
  });
  perRoot.set(rootSessionID, projection);
  return projection;
}

export function buildCurrentRouteSubtreeProjection(
  state: StatuslineState,
  sessionID: string,
): CurrentRouteSubtreeProjection {
  return {
    state,
    sessionID,
    subtree: projectSubagentSubtreeCached(
      getSubagentLineageIndex(state),
      sessionID,
    ),
  };
}

export function createCurrentRouteSubtreeCoordinator(input: {
  readonly build?: CurrentRouteSubtreeBuilder;
} = {}): {
  readonly read: (input: {
    readonly state: StatuslineState;
    readonly sessionID: string | undefined;
  }) => CurrentRouteSubtreeProjection | undefined;
} {
  const build = input.build ?? buildCurrentRouteSubtreeProjection;
  let cachedState: StatuslineState | undefined;
  let cachedSessionID: string | undefined;
  let cachedProjection: CurrentRouteSubtreeProjection | undefined;

  return {
    read(current) {
      if (!current.sessionID) return undefined;
      if (
        current.state === cachedState &&
        current.sessionID === cachedSessionID &&
        cachedProjection
      ) {
        return cachedProjection;
      }

      cachedState = current.state;
      cachedSessionID = current.sessionID;
      cachedProjection = build(current.state, current.sessionID);
      return cachedProjection;
    },
  };
}
