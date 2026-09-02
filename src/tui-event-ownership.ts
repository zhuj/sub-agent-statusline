export type TuiEventOwnership = "owned" | "foreign" | "unknown";

export type TuiEventLineage = {
  readonly id: string;
  readonly parentID: string;
  readonly source?: "session" | "subtask" | "tool";
  readonly targetSessionID?: string;
};

export type TuiEventOwnershipContext = {
  readonly currentDirectory: string;
  readonly routeSessionID?: string;
  readonly children: Readonly<Record<string, TuiEventLineage>>;
  readonly acceptedSessionIDs?: ReadonlySet<string>;
  readonly getSessionDirectory: (sessionID: string) => string | undefined;
};

export type TuiEventOwnershipDecision =
  | {
      readonly kind: "owned";
      readonly acceptedSessionIDs: readonly string[];
    }
  | { readonly kind: "foreign" }
  | { readonly kind: "unknown" };

type ParsedOwnershipEvent = {
  readonly sessionID: string;
  readonly directory?: string;
  readonly relatedSessionIDs: readonly string[];
};

const UNKNOWN_DECISION = { kind: "unknown" } as const;
const FOREIGN_DECISION = { kind: "foreign" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseInfoSessionEvent(
  properties: Record<string, unknown>,
): ParsedOwnershipEvent | undefined {
  const sessionID = nonEmptyString(properties["sessionID"]);
  const info = properties["info"];
  if (!sessionID || !isRecord(info)) return undefined;
  const nestedSessionID = nonEmptyString(info["id"]);
  const directory = nonEmptyString(info["directory"]);
  if (!nestedSessionID || nestedSessionID !== sessionID || !directory) {
    return undefined;
  }
  const parentValue = info["parentID"];
  const parentID = nonEmptyString(parentValue);
  if (parentValue !== undefined && !parentID) return undefined;
  return { sessionID, directory, relatedSessionIDs: [sessionID] };
}

function parseNestedSessionEvent(
  properties: Record<string, unknown>,
  nestedKey: "info" | "part",
): ParsedOwnershipEvent | undefined {
  const sessionID = nonEmptyString(properties["sessionID"]);
  const nested = properties[nestedKey];
  if (!sessionID || !isRecord(nested)) return undefined;
  const nestedSessionID = nonEmptyString(nested["sessionID"]);
  if (!nestedSessionID || nestedSessionID !== sessionID) return undefined;
  if (!nonEmptyString(nested["id"])) return undefined;
  if (nestedKey === "info") {
    const role = nested["role"];
    if (role !== "user" && role !== "assistant") return undefined;
  } else if (
    !nonEmptyString(nested["messageID"]) ||
    !nonEmptyString(nested["type"])
  ) {
    return undefined;
  }
  return { sessionID, relatedSessionIDs: [sessionID] };
}

function isSessionStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = value["type"];
  if (type === "idle" || type === "busy") return true;
  return (
    type === "retry" &&
    typeof value["attempt"] === "number" &&
    typeof value["message"] === "string" &&
    typeof value["next"] === "number"
  );
}

function parseTuiOwnershipEvent(
  event: unknown,
): ParsedOwnershipEvent | undefined {
  if (!isRecord(event)) return undefined;
  const type = nonEmptyString(event["type"]);
  const properties = event["properties"];
  if (!type || !isRecord(properties)) return undefined;

  switch (type) {
    case "session.created":
    case "session.updated":
      return parseInfoSessionEvent(properties);
    case "session.status":
      if (!isSessionStatus(properties["status"])) return undefined;
      break;
    case "session.idle":
    case "session.error":
      break;
    case "message.updated":
      return parseNestedSessionEvent(properties, "info");
    case "message.part.updated":
      return parseNestedSessionEvent(properties, "part");
    default:
      return undefined;
  }

  const sessionID = nonEmptyString(properties["sessionID"]);
  return sessionID
    ? { sessionID, relatedSessionIDs: [sessionID] }
    : undefined;
}

function collectAnchoredSessionIDs(
  context: TuiEventOwnershipContext,
): ReadonlySet<string> {
  const anchored = new Set(context.acceptedSessionIDs ?? []);
  if (context.routeSessionID) anchored.add(context.routeSessionID);
  const childrenByParent = new Map<string, string[]>();
  for (const child of Object.values(context.children)) {
    if (child.source !== "session") continue;
    const descendants = childrenByParent.get(child.parentID) ?? [];
    descendants.push(child.id);
    childrenByParent.set(child.parentID, descendants);
  }

  const queue = [...anchored];
  for (let index = 0; index < queue.length; index += 1) {
    const parentID = queue[index];
    if (!parentID) continue;
    for (const sessionID of childrenByParent.get(parentID) ?? []) {
      if (anchored.has(sessionID)) continue;
      anchored.add(sessionID);
      queue.push(sessionID);
    }
  }
  return anchored;
}

export function classifyTuiEventOwnership(
  event: unknown,
  context: TuiEventOwnershipContext,
): TuiEventOwnershipDecision {
  if (context.currentDirectory.length === 0) return UNKNOWN_DECISION;
  const parsed = parseTuiOwnershipEvent(event);
  if (!parsed) return UNKNOWN_DECISION;

  if (parsed.directory !== undefined) {
    return parsed.directory === context.currentDirectory
      ? {
          kind: "owned",
          acceptedSessionIDs: parsed.relatedSessionIDs,
        }
      : FOREIGN_DECISION;
  }

  const knownDirectory = context.getSessionDirectory(parsed.sessionID);
  if (knownDirectory !== undefined) {
    return knownDirectory === context.currentDirectory
      ? { kind: "owned", acceptedSessionIDs: parsed.relatedSessionIDs }
      : FOREIGN_DECISION;
  }

  return collectAnchoredSessionIDs(context).has(parsed.sessionID)
    ? { kind: "owned", acceptedSessionIDs: parsed.relatedSessionIDs }
    : UNKNOWN_DECISION;
}

export type TuiEventOwnershipGate = {
  readonly accepts: (
    event: unknown,
    context: TuiEventOwnershipContext,
  ) => boolean;
};

export function createTuiEventOwnershipGate(): TuiEventOwnershipGate {
  let lifetimeDirectory: string | undefined;
  const acceptedSessionIDs = new Set<string>();

  return {
    accepts(event, context) {
      if (lifetimeDirectory !== context.currentDirectory) {
        acceptedSessionIDs.clear();
        lifetimeDirectory = context.currentDirectory;
      }
      const decision = classifyTuiEventOwnership(event, {
        ...context,
        acceptedSessionIDs,
      });
      if (decision.kind !== "owned") return false;
      for (const sessionID of decision.acceptedSessionIDs) {
        acceptedSessionIDs.add(sessionID);
      }
      return true;
    },
  };
}
