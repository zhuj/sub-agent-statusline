import { mapWithBoundedConcurrency } from "./tui-hydration.js";

export const DESCENDANT_DISCOVERY_CONCURRENCY = 4 as const;

export interface DiscoveredSession {
  readonly id: string;
  readonly parentID: string;
  readonly directory: string;
  readonly title?: string;
  readonly time?: Readonly<Record<string, unknown>>;
}

export interface DescendantDiscoveryResult {
  readonly sessions: readonly DiscoveredSession[];
  readonly queriedSessionIDs: ReadonlySet<string>;
  readonly cancelled: boolean;
  readonly hadFailure: boolean;
}

type DiscoveryInput = {
  readonly rootSessionID: string;
  readonly directory: string;
  readonly signal: AbortSignal;
  readonly readChildren: (
    parentSessionID: string,
  ) => Promise<readonly unknown[]>;
};

function parseDiscoveredSession(
  value: unknown,
  parentSessionID: string,
  directory: string,
): DiscoveredSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const id = Reflect.get(value, "id");
  const parentID = Reflect.get(value, "parentID");
  const rowDirectory = Reflect.get(value, "directory");
  const title = Reflect.get(value, "title");
  const time = Reflect.get(value, "time");
  if (
    typeof id !== "string" ||
    !id.startsWith("ses_") ||
    id.length <= 4 ||
    parentID !== parentSessionID ||
    rowDirectory !== directory ||
    (title !== undefined && typeof title !== "string") ||
    (time !== undefined &&
      (typeof time !== "object" || time === null || Array.isArray(time)))
  ) {
    return undefined;
  }

  return {
    id,
    parentID,
    directory: rowDirectory,
    ...(title === undefined ? {} : { title }),
    ...(time === undefined
      ? {}
      : {
          time: {
            created: Reflect.get(time, "created"),
            updated: Reflect.get(time, "updated"),
            completed: Reflect.get(time, "completed"),
          },
        }),
  };
}

export async function discoverDescendantSessions(
  input: DiscoveryInput,
): Promise<DescendantDiscoveryResult> {
  const admittedSessionIDs = new Set<string>([input.rootSessionID]);
  const queriedSessionIDs = new Set<string>();
  const sessions: DiscoveredSession[] = [];
  let frontier = [input.rootSessionID];
  let hadFailure = false;

  discovery: while (frontier.length > 0 && !input.signal.aborted) {
    const levelResults = await mapWithBoundedConcurrency(
      frontier,
      DESCENDANT_DISCOVERY_CONCURRENCY,
      async (parentSessionID) => {
        if (input.signal.aborted) return { rows: [], failed: false };
        queriedSessionIDs.add(parentSessionID);
        try {
          return {
            rows: await input.readChildren(parentSessionID),
            failed: false,
          };
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          return { rows: [], failed: !input.signal.aborted };
        }
      },
    );
    if (input.signal.aborted) break;

    const nextFrontier: string[] = [];
    for (let index = 0; index < frontier.length; index += 1) {
      if (input.signal.aborted) break discovery;
      const parentSessionID = frontier[index];
      const levelResult = levelResults[index];
      if (!parentSessionID || !levelResult) continue;
      hadFailure = hadFailure || levelResult.failed;
      for (const row of levelResult.rows) {
        if (input.signal.aborted) break discovery;
        const session = parseDiscoveredSession(
          row,
          parentSessionID,
          input.directory,
        );
        if (!session || admittedSessionIDs.has(session.id)) continue;
        admittedSessionIDs.add(session.id);
        sessions.push(session);
        nextFrontier.push(session.id);
      }
    }
    frontier = nextFrontier;
  }

  return {
    sessions,
    queriedSessionIDs,
    cancelled: input.signal.aborted,
    hadFailure,
  };
}
