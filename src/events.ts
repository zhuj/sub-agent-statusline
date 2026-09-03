import type {
  ChildModelState,
  ChildTokenState,
  StatuslineState,
} from "./state.js";
import {
  deriveOpenCodeSessionStatus,
  hasStructuredErrorEvidence,
} from "./reconcile.js";
import { isRealSessionID } from "./subagent-classification.js";
import {
  markChildStatus,
  parseTimestamp,
  setChildModel,
  upsertChildDetails,
  upsertRunningChild,
} from "./state.js";

export type EventLike = {
  type?: unknown;
  title?: unknown;
  name?: unknown;
  sessionID?: unknown;
  sessionId?: unknown;
  status?: unknown;
  state?: unknown;
  properties?: {
    id?: unknown;
    sessionID?: unknown;
    sessionId?: unknown;
    title?: unknown;
    name?: unknown;
    info?: {
      id?: unknown;
      title?: unknown;
      name?: unknown;
      agent?: unknown;
      subagent_type?: unknown;
      sessionID?: unknown;
      sessionId?: unknown;
      parentID?: unknown;
      role?: unknown;
      time?: unknown;
      status?: unknown;
      state?: unknown;
    };
    parentID?: unknown;
    part?: unknown;
    status?: unknown;
    state?: unknown;
  };
  parentID?: unknown;
  [key: string]: unknown;
};

type SubtaskChild = {
  id: string;
  title: string;
  summary?: string;
  agentName?: string;
  parentID: string;
  messageID: string;
  targetSessionID?: string;
  startedAt?: string;
  updatedAt?: string;
};

type ToolChild = SubtaskChild & {
  toolName: "delegate" | "task";
  status: "running" | "done" | "error";
  endedAt?: string;
};

export type TaskToolStatus = "running" | "done" | "error";

export type TaskToolEvidence = {
  status: TaskToolStatus;
  targetSessionID?: string;
  endedAt?: string;
};

type SyntheticTargetContext = {
  id: string;
  parentID: string;
  messageID?: string;
};

export type EventMutationCategory =
  | "insert"
  | "details"
  | "status"
  | "model"
  | "target";

export type SubagentEventTransaction = {
  changed: boolean;
  changedChildIDs: string[];
  mutationCategories: EventMutationCategory[];
};

import {
  childLookupKey as lookupKey,
  createChildLookup,
  lookupChildren,
  refreshChildLookup,
  type ChildLookup,
} from "./events-lookup.js";

export { createChildLookup, refreshChildLookup, setChildTarget } from "./events-lookup.js";
export type { ChildLookup } from "./events-lookup.js";

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeMessage(value: unknown): Record<string, unknown> | undefined {
  const message = isRecord(value) ? value : undefined;
  if (!message) return undefined;
  return isRecord(message.info) ? message.info : message;
}

function messageActivityMs(message: Record<string, unknown>): number {
  const time = isRecord(message.time) ? message.time : undefined;
  const value = time?.completed ?? time?.updated ?? time?.created;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function extractLatestAssistantModel(
  input: unknown | readonly unknown[],
): { sessionID: string; model?: ChildModelState; updatedAt?: string } | undefined {
  const values = Array.isArray(input) ? input : [input];
  let latest: Record<string, unknown> | undefined;
  let latestActivity = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const message = normalizeMessage(value);
    if (message?.role !== "assistant") continue;
    const activity = messageActivityMs(message);
    if (activity >= latestActivity) {
      latest = message;
      latestActivity = activity;
    }
  }
  if (!latest) return undefined;
  const sessionID = asString(latest.sessionID);
  if (!sessionID) return undefined;
  const providerID = asString(latest.providerID)?.trim();
  const modelID = asString(latest.modelID)?.trim();
  const variant = asString(latest.variant)?.trim();
  const model =
    providerID && modelID
      ? { providerID, modelID, ...(variant ? { variant } : {}) }
      : undefined;
  const activity = messageActivityMs(latest);
  return {
    sessionID,
    model,
    updatedAt: activity > 0 ? new Date(activity).toISOString() : undefined,
  };
}

function conciseText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

function sameDisplayText(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.replace(/\s+/g, " ").trim().toLowerCase() ===
    b.replace(/\s+/g, " ").trim().toLowerCase()
  );
}

function firstDistinctSummary(
  candidates: unknown[],
  title: string | undefined,
): string | undefined {
  for (const candidate of candidates) {
    const summary = conciseText(candidate);
    if (summary && !sameDisplayText(summary, title)) return summary;
  }
  return undefined;
}

function isTechnicalDelegationTitle(value: string | undefined): boolean {
  if (!value) return false;
  return /^delegation:\s+/i.test(value.trim());
}

function promptTitle(value: unknown): string | undefined {
  const text = conciseText(value);
  if (!text) return undefined;
  const sentence = text.match(/^(.+?[.!?])\s/)?.[1]?.trim();
  const title = sentence && sentence.length <= 100 ? sentence : text;
  return title.length > 100 ? `${title.slice(0, 99)}…` : title;
}

function firstUsefulTitle(candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const title = promptTitle(candidate);
    if (title && !isTechnicalDelegationTitle(title)) return title;
  }
  return undefined;
}

export function extractCreatedChild(event: EventLike): {
  id: string;
  title: string;
  agentName?: string;
  parentID: string;
  startedAt?: string;
  updatedAt?: string;
} | null {
  const info = event.properties?.info;
  const parentID = asString(info?.parentID);
  if (!parentID) return null;

  const id = asString(info?.id) ?? asString(event.properties?.id);
  if (!id) return null;

  const title = asString(info?.title) ?? "subagent";
  const agentName = asString(info?.agent) ?? asString(info?.subagent_type);
  const startedAt = extractEventTimestamp(event, [
    "started",
    "start",
    "created",
    "updated",
  ]);
  const updatedAt =
    extractEventTimestamp(event, ["updated", "created", "started", "start"]) ??
    startedAt;
  return { id, title, agentName, parentID, startedAt, updatedAt };
}

export function extractSessionID(event: EventLike): string | undefined {
  return (
    asString(event.properties?.sessionID) ??
    asString(event.properties?.sessionId) ??
    asString(event.properties?.info?.sessionID) ??
    asString(event.properties?.info?.sessionId) ??
    asString(event.sessionID) ??
    asString(event.sessionId) ??
    asString(event.properties?.info?.id) ??
    asString(event.properties?.id)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function collectSessionIDs(
  input: unknown,
  target: Set<string>,
  depth = 0,
): void {
  if (depth > 4 || !input) return;

  const sessionID = asString(input);
  if (isRealSessionID(sessionID)) {
    target.add(sessionID);
    return;
  }

  if (!isRecord(input) && !Array.isArray(input)) return;

  if (Array.isArray(input)) {
    for (const value of input) {
      collectSessionIDs(value, target, depth + 1);
    }
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    if (!key.toLowerCase().includes("session")) continue;
    collectSessionIDs(value, target, depth + 1);
  }
}

/**
 * Optional diagnostic sink used by `resolveSyntheticTargetSessionID` when it
 * falls back to `undefined` because of ambiguity. Wired by the TUI plugin
 * to its JSONL event log; tests can pass a capture function.
 */
export type SubagentDebugSink = (entry: Record<string, unknown>) => void;

let _subagentDebugSink: SubagentDebugSink | undefined;

export function __setSubagentDebugSink(sink: SubagentDebugSink | undefined): void {
  _subagentDebugSink = sink;
}

function emitSubagentDebug(entry: Record<string, unknown>): void {
  _subagentDebugSink?.(entry);
}

export function resolveSyntheticTargetSessionID(
  state: StatuslineState,
  synthetic: SyntheticTargetContext,
  explicitCandidates: readonly string[] = [],
  lookup = createChildLookup(state),
): string | undefined {
  const candidates = new Set<string>(
    explicitCandidates.filter(isRealSessionID),
  );

  const byMessage = lookupChildren(
    state,
    lookup,
    lookup.sessionsByParentMessage,
    synthetic.messageID
      ? lookupKey(synthetic.parentID, synthetic.messageID)
      : undefined,
  );
  if (byMessage.length === 1) {
    candidates.add(byMessage[0].id);
  }

  const byParent = lookupChildren(
    state,
    lookup,
    lookup.sessionsByParent,
    synthetic.parentID,
  );
  if (byParent.length === 1) {
    candidates.add(byParent[0].id);
  }

  if (candidates.size === 1) return [...candidates][0];

  // Fail-closed: do not invent a relationship. Surface the ambiguity via the
  // optional debug sink so maintainers can investigate "missing subagent in
  // sidebar" reports without changing the merge result.
  emitSubagentDebug({
    kind: "subagent.target.ambiguous",
    childID: synthetic.id,
    parentID: synthetic.parentID,
    messageID: synthetic.messageID,
    candidateCount: candidates.size,
    explicitCount: explicitCandidates.filter(isRealSessionID).length,
    byMessageCount: byMessage.length,
    byParentCount: byParent.length,
  });

  return undefined;
}

function extractPartTargetSessionCandidates(event: EventLike): string[] {
  const part = isRecord(event.properties?.part)
    ? event.properties.part
    : undefined;
  if (!part) return [];

  const candidates = new Set<string>();
  collectSessionIDs(part, candidates);

  const parentSessionID = asString(part.sessionID) ?? extractSessionID(event);
  if (parentSessionID) candidates.delete(parentSessionID);

  return [...candidates];
}

function parseTaskSessionIDFromOutput(
  value: unknown,
  parentSessionID?: string,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const matches = [...value.matchAll(/\b(?:task_id\s*:\s*)?(ses_[a-zA-Z0-9_-]+)\b/gi)];
  const candidates = new Set(matches.map((match) => match[1]));
  if (parentSessionID) candidates.delete(parentSessionID);
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function backfillSyntheticTargetsForSession(
  state: StatuslineState,
  session: {
    id: string;
    parentID: string;
    messageID?: string;
    updatedAt?: string;
  },
  lookup: ChildLookup,
): { changed: boolean; childIDs: string[] } {
  const targetlessSynthetic = lookupChildren(
    state,
    lookup,
    lookup.syntheticByParent,
    session.parentID,
  ).filter((child) => !child.targetSessionID);

  const messageMatches = session.messageID
    ? targetlessSynthetic.filter(
        (child) => child.messageID === session.messageID,
      )
    : [];
  const existingSessionSiblings = lookupChildren(
    state,
    lookup,
    lookup.sessionLikeByParent,
    session.parentID,
  ).filter((child) => child.id !== session.id);
  const candidates =
    messageMatches.length > 0 ? messageMatches : targetlessSynthetic;
  if (candidates.length !== 1) return { changed: false, childIDs: [] };
  if (messageMatches.length === 0 && existingSessionSiblings.length > 0) {
    return { changed: false, childIDs: [] };
  }

  const synthetic = candidates[0];
  const targetSessionID = resolveSyntheticTargetSessionID(
    state,
    {
      id: synthetic.id,
      parentID: synthetic.parentID,
      messageID: synthetic.messageID,
    },
    [session.id],
    lookup,
  );
  if (targetSessionID !== session.id) return { changed: false, childIDs: [] };

  const changed = upsertChildDetails(state, synthetic.id, {
    targetSessionID,
    updatedAt: session.updatedAt,
  });
  return { changed, childIDs: changed ? [synthetic.id] : [] };
}

export function extractTaskToolEvidence(
  event: EventLike,
): TaskToolEvidence | null {
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== "tool") return null;
  if (asString(part.tool) !== "task") return null;

  const state = isRecord(part.state) ? part.state : undefined;
  if (!state) return null;

  const rawStatus = asString(state.status);
  const status: TaskToolStatus =
    rawStatus === "completed"
      ? "done"
      : rawStatus === "error"
        ? "error"
        : "running";

  const metadata = isRecord(state.metadata) ? state.metadata : undefined;
  const targetFromMetadata = asString(metadata?.sessionId);
  const parentSessionID = asString(part.sessionID) ?? extractSessionID(event);
  const targetFromOutput = parseTaskSessionIDFromOutput(
    state.output,
    parentSessionID,
  );
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const targetSessionID =
    targetFromMetadata ??
    targetFromOutput ??
    (targetCandidates.length === 1 ? targetCandidates[0] : undefined);

  const endedAt =
    status === "done" || status === "error"
      ? extractEventTimestamp(event, ["completed", "end", "ended", "updated"])
      : undefined;

  return {
    status,
    targetSessionID,
    endedAt,
  };
}

function mapTaskToolToSubtaskID(
  state: StatuslineState,
  task: {
    parentID: string;
    messageID: string;
    parentMessageID?: string;
    title: string;
    summary?: string;
    agentName?: string;
    targetSessionID?: string;
  },
  lookup: ChildLookup,
): string | undefined {
  const primaryCandidates = lookupChildren(
    state,
    lookup,
    lookup.runningSubtasksByParentMessage,
    lookupKey(task.parentID, task.messageID),
  );
  const legacyCandidates = task.parentMessageID
    ? lookupChildren(
        state,
        lookup,
        lookup.runningSubtasksByParentMessage,
        lookupKey(task.parentID, task.parentMessageID),
      )
    : [];
  const candidates =
    primaryCandidates.length > 0 ? primaryCandidates : legacyCandidates;
  if (candidates.length === 0) return undefined;

  if (task.targetSessionID) {
    const byTarget = candidates.filter(
      (child) => child.targetSessionID === task.targetSessionID,
    );
    if (byTarget.length === 1) return byTarget[0].id;
  }

  const byTitle = candidates.filter((child) =>
    sameDisplayText(child.title, task.title),
  );
  if (byTitle.length === 1) return byTitle[0].id;

  const bySummary = candidates.filter((child) =>
    sameDisplayText(child.summary, task.summary),
  );
  if (bySummary.length === 1) return bySummary[0].id;

  const byAgent = task.agentName
    ? candidates.filter((child) =>
        sameDisplayText(child.agentName, task.agentName),
      )
    : [];
  if (byAgent.length === 1) return byAgent[0].id;

  if (candidates.length === 1) return candidates[0].id;
  return undefined;
}

function extractParentMessageID(event: EventLike): string | undefined {
  return (
    asString(event.properties?.info?.parentID) ??
    asString(event.properties?.parentID) ??
    asString(event.parentID)
  );
}

function extractEventTimestamp(
  event: EventLike,
  keys: string[],
): string | undefined {
  const part = isRecord(event.properties?.part)
    ? event.properties?.part
    : undefined;
  const state = isRecord(part?.state) ? part?.state : undefined;
  const sources = [
    isRecord(event.properties?.info?.time)
      ? event.properties?.info?.time
      : undefined,
    isRecord(part?.time) ? part?.time : undefined,
    isRecord(part?.timestamps) ? part?.timestamps : undefined,
    isRecord(state?.time) ? state?.time : undefined,
    isRecord(state?.timestamps) ? state?.timestamps : undefined,
    state,
    part,
  ];

  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const candidate = parseTimestamp(source[key]);
      if (candidate) return candidate;
    }
  }

  return undefined;
}

function extractSubtaskChild(event: EventLike): SubtaskChild | null {
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== "subtask") return null;

  const partID = asString(part.id);
  const parentID = asString(part.sessionID) ?? extractSessionID(event);
  const messageID = asString(part.messageID);
  if (!partID || !parentID || !messageID) return null;

  const description = asString(part.description);
  const command = asString(part.command);
  const agent = asString(part.agent);
  const title = description || command || agent || "subtask";
  const state = isRecord(part.state) ? part.state : undefined;
  const input = isRecord(state?.input) ? state.input : undefined;
  const summary = firstDistinctSummary(
    [input?.prompt, input?.description, part.description, state?.description],
    title,
  );
  const startedAt = extractEventTimestamp(event, [
    "started",
    "start",
    "created",
    "updated",
  ]);
  const updatedAt =
    extractEventTimestamp(event, ["updated", "created", "started", "start"]) ??
    startedAt;
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const targetSessionID =
    targetCandidates.length === 1 ? targetCandidates[0] : undefined;

  return {
    id: `subtask:${partID}`,
    title,
    summary,
    agentName: agent,
    parentID,
    messageID,
    targetSessionID,
    startedAt,
    updatedAt,
  };
}

function extractToolChild(event: EventLike): ToolChild | null {
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== "tool") return null;

  const tool = asString(part.tool);
  if (tool !== "delegate" && tool !== "task") return null;

  const partID = asString(part.id);
  const parentID = asString(part.sessionID) ?? extractSessionID(event);
  const messageID = asString(part.messageID);
  const state = isRecord(part.state) ? part.state : undefined;
  if (!partID || !parentID || !messageID || !state) return null;

  const taskEvidence = extractTaskToolEvidence(event);
  const rawStatus = asString(state.status);
  const status =
    taskEvidence?.status ??
    (rawStatus === "completed"
      ? "done"
      : rawStatus === "error"
        ? "error"
        : "running");

  const input = isRecord(state.input) ? state.input : {};
  const description = asString(input.description);
  const subagentType = asString(input.subagent_type);
  const rawTitle = asString(state.title);
  const title =
    (isTechnicalDelegationTitle(rawTitle) ? undefined : rawTitle) ||
    description ||
    firstUsefulTitle([input.prompt, part.description, state.description]) ||
    subagentType ||
    tool;
  const summary = firstDistinctSummary(
    [input.prompt, input.description, part.description, state.description],
    title,
  );
  const startedAt = extractEventTimestamp(event, [
    "started",
    "start",
    "created",
    "updated",
  ]);
  const updatedAt =
    extractEventTimestamp(event, [
      "updated",
      "completed",
      "created",
      "started",
      "start",
    ]) ?? startedAt;
  const endedAt =
    status === "done" || status === "error"
      ? extractEventTimestamp(event, ["completed", "end", "ended", "updated"])
      : undefined;
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const targetSessionID =
    taskEvidence?.targetSessionID ??
    (targetCandidates.length === 1 ? targetCandidates[0] : undefined);

  return {
    id: `tool:${partID}`,
    title,
    summary,
    agentName: subagentType,
    parentID,
    messageID,
    toolName: tool,
    targetSessionID,
    status,
    startedAt,
    updatedAt,
    endedAt,
  };
}

function extractCompletedAssistantMessage(event: EventLike): {
  sessionID: string;
  messageID: string;
} | null {
  const info = event.properties?.info;
  if (!isRecord(info)) return null;
  if (info.role !== "assistant") return null;

  const time = info.time;
  if (!isRecord(time) || typeof time.completed !== "number") return null;

  const sessionID = asString(info.sessionID) ?? extractSessionID(event);
  const messageID = asString(info.id);
  if (!sessionID || !messageID) return null;
  return { sessionID, messageID };
}

function extractDetailTargetIDs(event: EventLike): string[] {
  const ids = new Set<string>();
  const part = event.properties?.part;

  if (isRecord(part)) {
    const partID = asString(part.id);
    if (part.type === "subtask" && partID) {
      ids.add(`subtask:${partID}`);
    }

    if (part.type === "tool") {
      const tool = asString(part.tool);
      if ((tool === "delegate" || tool === "task") && partID) {
        ids.add(`tool:${partID}`);
      }
    }
  }

  const sessionID = extractSessionID(event);
  if (sessionID) ids.add(sessionID);

  return [...ids];
}

function normalizePercent(value: number): number {
  if (value > 0 && value <= 1) {
    return value * 100;
  }
  return value;
}

export function extractChildDetails(event: EventLike): {
  title?: string;
  summary?: string;
  agentName?: string;
  tokens?: ChildTokenState;
  updatedAt?: string;
} {
  const details: {
    title?: string;
    summary?: string;
    agentName?: string;
    tokens?: ChildTokenState;
    updatedAt?: string;
  } = {};

  details.updatedAt = extractEventTimestamp(event, [
    "updated",
    "completed",
    "created",
    "started",
    "start",
  ]);

  const titleCandidates = [
    event.properties?.info?.title,
    event.properties?.title,
    event.properties?.info?.name,
    event.properties?.name,
    event.title,
    event.name,
  ];

  for (const candidate of titleCandidates) {
    const title = asString(candidate);
    if (title) {
      details.title = title;
      break;
    }
  }

  const part = isRecord(event.properties?.part)
    ? event.properties.part
    : undefined;
  const partState = isRecord(part?.state) ? part.state : undefined;
  const partInput = isRecord(partState?.input) ? partState.input : undefined;
  details.agentName =
    asString(partInput?.subagent_type) ??
    asString(partInput?.agent) ??
    asString(part?.agent) ??
    asString(event.properties?.info?.agent) ??
    asString(event.properties?.info?.subagent_type);
  details.summary = firstDistinctSummary(
    [
      partInput?.prompt,
      partInput?.description,
      part?.description,
      partState?.description,
    ],
    details.title,
  );
  if (isTechnicalDelegationTitle(details.title)) {
    const replacementTitle =
      asString(partInput?.description) ??
      firstUsefulTitle([
        partInput?.prompt,
        part?.description,
        partState?.description,
      ]);
    if (replacementTitle) {
      details.title = replacementTitle;
    }
  }

  const tokenHints: ChildTokenState = {};
  const visited = new Set<object>();

  const isTokenHintsComplete = (): boolean =>
    tokenHints.input !== undefined &&
    tokenHints.output !== undefined &&
    tokenHints.total !== undefined &&
    tokenHints.contextPercent !== undefined;

  const walk = (
    node: unknown,
    depth: number,
    tokenContainer = false,
  ): void => {
    if (!isRecord(node) || depth > 6) return;
    // Short-circuit once every token field is resolved; traversing further
    // only yields redundant matches and increases event-loop pressure during
    // message-bursty workloads.
    if (isTokenHintsComplete()) return;
    if (visited.has(node)) return;
    visited.add(node);

    for (const [rawKey, rawValue] of Object.entries(node)) {
      const key = rawKey.toLowerCase();
      const asNumber =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string" && rawValue.trim().length > 0
            ? Number(rawValue)
            : undefined;

      if (typeof asNumber === "number" && Number.isFinite(asNumber)) {
        if (tokenContainer && key === "input") {
          tokenHints.input = asNumber;
        } else if (tokenContainer && key === "output") {
          tokenHints.output = asNumber;
        } else if (tokenContainer && key === "total") {
          tokenHints.total = asNumber;
        } else if (tokenContainer && key === "contextpercent") {
          tokenHints.contextPercent = normalizePercent(asNumber);
        } else if (key.includes("context") && key.includes("percent")) {
          tokenHints.contextPercent = normalizePercent(asNumber);
        } else if (key.includes("context") && key.includes("usage")) {
          tokenHints.contextPercent = normalizePercent(asNumber);
        } else if (
          (key.includes("input") || key.includes("prompt")) &&
          key.includes("token")
        ) {
          tokenHints.input = asNumber;
        } else if (
          (key.includes("output") || key.includes("completion")) &&
          key.includes("token")
        ) {
          tokenHints.output = asNumber;
        } else if (key.includes("total") && key.includes("token")) {
          tokenHints.total = asNumber;
        } else if (key === "tokens" || key === "token") {
          tokenHints.total = asNumber;
        }
      }

      if (isRecord(rawValue)) {
        walk(
          rawValue,
          depth + 1,
          tokenContainer || key === "tokens" || key === "token",
        );
      }
    }
  };

  walk(event, 0);

  if (
    tokenHints.input !== undefined ||
    tokenHints.output !== undefined ||
    tokenHints.total !== undefined ||
    tokenHints.contextPercent !== undefined
  ) {
    details.tokens = tokenHints;
  }

  return details;
}

export function applySubagentEventDetailed(
  state: StatuslineState,
  event: unknown,
  lookup: ChildLookup = createChildLookup(state),
): SubagentEventTransaction {
  const result: SubagentEventTransaction = {
    changed: false,
    changedChildIDs: [],
    mutationCategories: [],
  };
  const recordedChildIDs = new Set<string>();
  const record = (
    changed: boolean,
    childIDs: readonly string[],
    category: EventMutationCategory,
  ): void => {
    if (!changed) return;
    result.changed = true;
    for (const childID of childIDs) {
      if (!recordedChildIDs.has(childID)) {
        recordedChildIDs.add(childID);
        result.changedChildIDs.push(childID);
      }
      refreshChildLookup(lookup, state, childID);
    }
    if (!result.mutationCategories.includes(category)) {
      result.mutationCategories.push(category);
    }
  };
  const e = (event ?? {}) as EventLike;
  const type = asString(e.type);
  if (!type) return result;

  if (type === "session.created" || type === "session.updated") {
    const child = extractCreatedChild(e);
    if (child && isRealSessionID(child.id)) {
      const details = extractChildDetails(e);
      const inserted = upsertRunningChild(state, {
        ...child,
        source: "session",
        targetSessionID: child.id,
      });
      record(inserted, [child.id], "insert");
      const detailsChanged = upsertChildDetails(state, child.id, details);
      record(detailsChanged, [child.id], "details");
      const targetMutation = backfillSyntheticTargetsForSession(state, {
          id: child.id,
          parentID: child.parentID,
          updatedAt: child.updatedAt,
        }, lookup);
      record(targetMutation.changed, targetMutation.childIDs, "target");
      let changed = inserted || detailsChanged || targetMutation.changed;
      const sessionStatusFromUpdate =
        type === "session.updated"
          ? hasStructuredErrorEvidence(e.properties ?? e)
            ? "error"
            : deriveOpenCodeSessionStatus(
                e.properties?.status ??
                  e.properties?.state ??
                  e.properties?.info?.status ??
                  e.status ??
                  e.state,
              )
          : undefined;
      if (
        sessionStatusFromUpdate === "done" ||
        sessionStatusFromUpdate === "error"
      ) {
        const endedAt = extractEventTimestamp(e, [
          "completed",
          "end",
          "ended",
          "updated",
        ]);
        const statusCandidates = [
          child.id,
          ...lookupChildren(state, lookup, lookup.byTarget, child.id).map(
            (candidate) => candidate.id,
          ),
        ];
        const statusChanged = markChildStatus(
          state,
          child.id,
          sessionStatusFromUpdate,
          endedAt,
          statusCandidates,
        );
        record(statusChanged, statusCandidates, "status");
        changed = statusChanged || changed;
      }
      result.changed = result.changed || changed;
      return result;
    }
    return result;
  }

  if (type === "session.idle") {
    const childID = extractSessionID(e);
    if (!isRealSessionID(childID)) return result;
    const endedAt = extractEventTimestamp(e, [
      "completed",
      "end",
      "ended",
      "updated",
    ]);
    const details = extractChildDetails(e);
    const status =
      deriveOpenCodeSessionStatus(e.properties ?? e) === "error" ||
      hasStructuredErrorEvidence(e.properties ?? e)
        ? "error"
        : "done";
    const candidates = [
      childID,
      ...lookupChildren(state, lookup, lookup.byTarget, childID).map(
        (candidate) => candidate.id,
      ),
    ];
    const statusChanged = markChildStatus(
      state,
      childID,
      status,
      endedAt,
      candidates,
    );
    record(statusChanged, candidates, "status");
    const detailsChanged = upsertChildDetails(state, childID, details);
    record(detailsChanged, [childID], "details");
    return result;
  }

  if (type === "session.error") {
    const childID = extractSessionID(e);
    if (!isRealSessionID(childID)) return result;
    const endedAt = extractEventTimestamp(e, [
      "completed",
      "end",
      "ended",
      "updated",
    ]);
    const details = extractChildDetails(e);
    const candidates = [
      childID,
      ...lookupChildren(state, lookup, lookup.byTarget, childID).map(
        (candidate) => candidate.id,
      ),
    ];
    const statusChanged = markChildStatus(
      state,
      childID,
      "error",
      endedAt,
      candidates,
    );
    record(statusChanged, candidates, "status");
    const detailsChanged = upsertChildDetails(state, childID, details);
    record(detailsChanged, [childID], "details");
    return result;
  }

  if (type === "session.status") {
    const childID = extractSessionID(e);
    if (!isRealSessionID(childID)) return result;
    const status = hasStructuredErrorEvidence(e.properties ?? e)
      ? "error"
      : deriveOpenCodeSessionStatus(
          e.properties?.status ??
            e.properties?.state ??
            e.properties?.info?.status ??
            e.status ??
            e.state ??
            e.properties,
        );
    if (!status) return result;

    const endedAt =
      status === "done" || status === "error"
        ? extractEventTimestamp(e, ["completed", "end", "ended", "updated"])
        : undefined;
    const details = extractChildDetails(e);
    const candidates = [
      childID,
      ...lookupChildren(state, lookup, lookup.byTarget, childID).map(
        (candidate) => candidate.id,
      ),
    ];
    const statusChanged =
      status === "running"
        ? false
        : markChildStatus(state, childID, status, endedAt, candidates);
    record(statusChanged, candidates, "status");
    const detailsChanged = upsertChildDetails(state, childID, details);
    record(detailsChanged, [childID], "details");
    return result;
  }

  let changed = false;

  if (type === "message.part.updated") {
    const subtask = extractSubtaskChild(e);
    if (subtask) {
      const targetSessionID = resolveSyntheticTargetSessionID(
        state,
        {
          id: subtask.id,
          parentID: subtask.parentID,
          messageID: subtask.messageID,
        },
        subtask.targetSessionID ? [subtask.targetSessionID] : [],
        lookup,
      );
      const subtaskChanged = upsertRunningChild(state, {
          ...subtask,
          source: "subtask",
          targetSessionID,
          startedAt: subtask.startedAt,
          updatedAt: subtask.updatedAt,
        });
      record(subtaskChanged, [subtask.id], "insert");
      changed = subtaskChanged || changed;
    }

    const tool = extractToolChild(e);
    if (tool) {
      const targetSessionID = resolveSyntheticTargetSessionID(
        state,
        {
          id: tool.id,
          parentID: tool.parentID,
          messageID: tool.messageID,
        },
        tool.targetSessionID ? [tool.targetSessionID] : [],
        lookup,
      );
      const childChanged = upsertRunningChild(state, {
        ...tool,
        source: "tool",
        targetSessionID,
        startedAt: tool.startedAt,
        updatedAt: tool.updatedAt,
      });
      record(childChanged, [tool.id], "insert");
      changed = childChanged || changed;
      if (tool.status === "done" || tool.status === "error") {
        const toolStatusChanged = markChildStatus(
            state,
            tool.id,
            tool.status,
            tool.endedAt ?? tool.updatedAt,
            [
              tool.id,
              ...lookupChildren(state, lookup, lookup.byTarget, tool.id).map(
                (candidate) => candidate.id,
              ),
            ],
          );
        record(toolStatusChanged, [tool.id], "status");
        changed = toolStatusChanged || changed;

        if (
          asString(
            (e.properties?.part as Record<string, unknown> | undefined)?.tool,
          ) === "task"
        ) {
          const subtaskID = mapTaskToolToSubtaskID(state, {
            parentID: tool.parentID,
            messageID: tool.messageID,
            parentMessageID: extractParentMessageID(e),
            title: tool.title,
            summary: tool.summary,
            agentName: tool.agentName,
            targetSessionID: targetSessionID,
          }, lookup);
          if (subtaskID) {
            if (targetSessionID) {
              const targetChanged = upsertChildDetails(state, subtaskID, {
                  targetSessionID,
                  updatedAt: tool.updatedAt,
                });
              record(targetChanged, [subtaskID], "target");
              changed = targetChanged || changed;
            }
            const subtaskStatusChanged = markChildStatus(
                state,
                subtaskID,
                tool.status,
                tool.endedAt ?? tool.updatedAt,
                [subtaskID],
              );
            record(subtaskStatusChanged, [subtaskID], "status");
            changed = subtaskStatusChanged || changed;
          }
        }
      }
    }
  }

  if (type === "message.updated") {
    const assistantModel = extractLatestAssistantModel(e.properties?.info ?? e);
    if (assistantModel) {
      const modelCandidates = [
        assistantModel.sessionID,
        ...lookupChildren(
          state,
          lookup,
          lookup.byTarget,
          assistantModel.sessionID,
        ).map((candidate) => candidate.id),
      ];
      const modelChanged = setChildModel(
          state,
          assistantModel.sessionID,
          assistantModel.model,
          assistantModel.updatedAt,
          modelCandidates,
        );
      record(modelChanged, modelCandidates, "model");
      changed = modelChanged || changed;
    }
    const completed = extractCompletedAssistantMessage(e);
    if (completed) {
      const matchingIDs = lookupChildren(
        state,
        lookup,
        lookup.runningSubtasksByParentMessage,
        lookupKey(completed.sessionID, completed.messageID),
      ).map((child) => child.id);
      for (const childID of matchingIDs) {
        const closed = markChildStatus(state, childID, "done", undefined, [
          childID,
        ]);
        record(closed, [childID], "status");
        changed = closed || changed;
      }
    }
  }

  if (type === "message.updated" || type === "message.part.updated") {
    const details = extractChildDetails(e);
    for (const childID of extractDetailTargetIDs(e)) {
      if (state.children[childID]) {
        const detailsChanged = upsertChildDetails(state, childID, details);
        record(detailsChanged, [childID], "details");
        changed = detailsChanged || changed;
      }
    }
  }

  result.changed = result.changed || changed;
  return result;
}

export function applySubagentEvent(
  state: StatuslineState,
  event: unknown,
  lookup?: ChildLookup,
): boolean {
  return applySubagentEventDetailed(state, event, lookup).changed;
}
