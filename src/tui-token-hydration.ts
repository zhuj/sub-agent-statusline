import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { extractChildDetails } from "./events.js";
import type {
  ChildSessionState,
  ChildTokenState,
  StatuslineState,
} from "./state.js";

export type TuiStateReader = {
  readonly session: {
    readonly status: (sessionID: string) => unknown;
    readonly messages: (sessionID: string) => readonly unknown[] | undefined;
  };
  readonly part: (messageID: string) => unknown;
};

export interface HydrationReadContext {
  sessionStatus(sessionID: string): unknown | undefined;
  sessionMessages(sessionID: string): readonly unknown[] | undefined;
  messageParts(messageID: string): unknown | undefined;
  parentMessage(parentID: string, messageID: string): unknown | undefined;
}

export function createHydrationReadContext(
  reader: TuiStateReader,
): HydrationReadContext {
  const statusCache = new Map<string, unknown>();
  const messagesCache = new Map<string, readonly unknown[] | undefined>();
  const partsCache = new Map<string, unknown>();
  const parentMessagesByID = new Map<string, ReadonlyMap<string, unknown>>();

  const cached = <Value>(
    cache: Map<string, Value>,
    key: string,
    read: () => Value,
  ): Value | undefined => {
    if (cache.has(key)) return cache.get(key);
    try {
      const value = read();
      cache.set(key, value);
      return value;
    } catch {
      return undefined;
    }
  };

  const sessionMessages = (
    sessionID: string,
  ): readonly unknown[] | undefined =>
    cached(messagesCache, sessionID, () =>
      reader.session.messages(sessionID),
    );

  return {
    sessionStatus(sessionID) {
      return cached(statusCache, sessionID, () =>
        reader.session.status(sessionID),
      );
    },
    sessionMessages,
    messageParts(messageID) {
      return cached(partsCache, messageID, () => reader.part(messageID));
    },
    parentMessage(parentID, messageID) {
      if (!parentMessagesByID.has(parentID)) {
        const parentMessages = sessionMessages(parentID);
        if (!parentMessages) return undefined;

        const messagesByID = new Map<string, unknown>();
        for (const message of parentMessages) {
          const id = messageIDOf(message);
          if (id && !messagesByID.has(id)) messagesByID.set(id, message);
        }
        parentMessagesByID.set(parentID, messagesByID);
      }

      return parentMessagesByID.get(parentID)?.get(messageID);
    },
  };
}

function mergeTokenState(
  existing: ChildTokenState | undefined,
  incoming: ChildTokenState | undefined,
): ChildTokenState | undefined {
  if (!existing && !incoming) return undefined;
  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent,
  };
}

function hasTokenTotal(tokens: ChildTokenState | undefined): boolean {
  return typeof tokens?.total === "number" && Number.isFinite(tokens.total);
}

function sameTokens(
  left: ChildTokenState | undefined,
  right: ChildTokenState | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageIDOf(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) return undefined;
  const id = record.id ?? record.messageID ?? record.messageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function pushSessionCandidates(
  context: HydrationReadContext,
  sessionID: string | undefined,
  candidates: unknown[],
): void {
  if (!sessionID) return;

  const status = context.sessionStatus(sessionID);
  if (status) candidates.push(status);

  const messages = context.sessionMessages(sessionID);
  if (!messages) return;

  candidates.push(messages);
  for (const message of messages) {
    const messageID = messageIDOf(message);
    if (!messageID) continue;
    const parts = context.messageParts(messageID);
    if (parts) candidates.push(parts);
  }
}

function hydrateChildTokens(
  context: HydrationReadContext,
  child: ChildSessionState,
): ChildTokenState | undefined {
  const candidates: unknown[] = [];

  pushSessionCandidates(context, child.id, candidates);

  const messageID = child.messageID;
  if (messageID) {
    const parentParts = context.messageParts(messageID);
    if (parentParts) candidates.push(parentParts);

    const parentMessage = context.parentMessage(child.parentID, messageID);
    if (parentMessage) candidates.push(parentMessage);
  }

  let tokens: ChildTokenState | undefined;
  for (const candidate of candidates) {
    tokens = mergeTokenState(
      tokens,
      extractChildDetails(
        candidate as Parameters<typeof extractChildDetails>[0],
      ).tokens,
    );
  }

  return tokens;
}

export function hydrateStateTokensFromTuiState(
  api: TuiPluginApi,
  state: StatuslineState,
): boolean {
  const context = createHydrationReadContext(api.state);
  let changed = false;

  for (const child of Object.values(state.children)) {
    if (child.status !== "running" && hasTokenTotal(child.tokens)) continue;
    const hydrated = hydrateChildTokens(context, child);
    const nextTokens = mergeTokenState(child.tokens, hydrated);
    if (!sameTokens(child.tokens, nextTokens)) {
      state.children[child.id] = {
        ...child,
        tokens: nextTokens,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    }
  }

  return changed;
}
