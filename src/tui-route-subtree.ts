import {
  getSubagentLineageIndex,
  projectSubagentSubtree,
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

export function buildCurrentRouteSubtreeProjection(
  state: StatuslineState,
  sessionID: string,
): CurrentRouteSubtreeProjection {
  return {
    state,
    sessionID,
    subtree: projectSubagentSubtree({
      index: getSubagentLineageIndex(state),
      rootSessionID: sessionID,
      compareSiblings: byPriority,
    }),
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
