import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPromptRef,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import type {
  BoxRenderable,
  KeyEvent,
  MouseEvent,
  ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import {
  For,
  Show,
  createRoot,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { Accessor } from "solid-js";
import {
  applySubagentEvent,
  applySubagentEventDetailed,
  createChildLookup,
  refreshChildLookup,
  resolveSyntheticTargetSessionID,
  setChildTarget,
  type ChildLookup,
  extractChildDetails,
  extractLatestAssistantModel,
  extractTaskToolEvidence,
  __setSubagentDebugSink,
} from "./events.js";
import {
  byPriority,
  formatDuration,
  renderStatusLine,
  visibleSubagentWorkItems,
} from "./render.js";
import {
  awaitCurrentRunningReconcileResult,
  canSafelyCloseNoTargetPersistedCandidate,
  capCandidates,
  deriveOpenCodeSessionStatus,
  hasRecentMessageActivity,
  matchesRunningReconcileVersion,
  nextBackoffState,
  parseStaleRunningThresholdMs as parseConfiguredStaleRunningThresholdMs,
  resolvePersistedStaleSubtaskFromParentMessages,
  resolveSessionStatusWithMessageSummary,
  shouldApplyStaleRunningFallback,
  shouldSkipCandidateForBackoff,
  sweepRunningReconcileBackoff,
  summarizeSessionMessages,
  type PersistedStaleSubtaskCandidate,
  type RunningReconcileCacheEntry,
  type RunningReconcileEvidence,
  type RunningReconcileVersion,
  type SessionMessageSummary,
} from "./reconcile.js";
import {
  createManagedDeferredCallbacks,
  focusPromptWithDeferredRetry,
  resolveSidebarReturnFocusAction,
  resolveSiblingSidebarRefocus,
  shouldReleaseSidebarListFocus,
  type PendingSidebarRefocus,
} from "./tui-focus.js";
import {
  activateSidebarSelection,
  buildSidebarRowLayoutIndex,
  moveSidebarRowSelection,
  resolveSidebarRowWindow,
  resolveSidebarSelectedRowID,
} from "./tui-row-window.js";
import {
  createEmptyState,
  markChildStatus,
  isTerminalPruningDue,
  isTerminalPruningDueAt,
  gcStaleInstanceDirs,
  mergeTokens,
  refreshDerivedFields,
  resolveStatePath,
  resolveTextPath,
  sameChildModel,
  sameTokens,
  saveState,
  saveStatusText,
  setChildModel,
  upsertChildDetails,
  type ChildTokenState,
  type ChildSessionState,
  type StatusCounts,
  type StatuslineState,
} from "./state.js";
import {
  formatCompactPercentUsed,
  formatCompactTokenCount,
} from "./format.js";
import {
  buildSubagentProjection,
  buildSubagentProjectionFromChildren,
  filterVisibleFromCanonical,
  type SubagentTreeRow,
} from "./projection.js";
import {
  buildCurrentRouteSubtreeProjection,
  createCurrentRouteSubtreeCoordinator,
  type CurrentRouteSubtreeProjection,
} from "./tui-route-subtree.js";
import {
  createPersistenceCoordinator,
  type PersistenceCoordinator,
} from "./persistence.js";
import { takeColumns, textColumns, truncateToColumns } from "./text-width.js";
import {
  createBestEffortDisposer,
  registerSubagentCommands,
} from "./tui-commands.js";
import {
  HYDRATE_RETRY_MAX_ATTEMPTS,
  ROUTE_CHILD_MESSAGE_CONCURRENCY,
  ROUTE_CHILD_MESSAGE_LIMIT,
  createTokenHydrationQueue,
  mapWithBoundedConcurrency,
  mergeFreshHydratedTokens,
  raceRouteAbort,
  scheduleHydrateRetry,
  type TokenHydrationJob,
} from "./tui-hydration.js";
import {
  discoverDescendantSessions,
} from "./tui-descendant-hydration.js";
import { createTuiEventOwnershipGate } from "./tui-event-ownership.js";
import {
  activateSubagentTreeRow,
  resolveSubagentTreeRowTargetSessionID,
  resolveTreeRowLayout,
  SUBAGENT_TREE_ROW_PREFIX_COLUMNS,
  treeRowsLayoutSignature,
} from "./tui-tree-row.js";
import { t } from "./i18n.js";

export { activateSubagentTreeRow } from "./tui-tree-row.js";

const TUI_PLUGIN_ID = "subagent-statusline.tui";
const ELAPSED_TICK_MS = 1000;
const FALLBACK_SIDEBAR_WIDTH = 34;
const MIN_ROW_WIDTH = 24;
const MIN_LABEL_WIDTH = 8;
const MAINTENANCE_TICK_MS = 2_000;
const RUNNING_RECONCILE_MAINTENANCE_INTERVAL_MS = 10 * 60_000;
const RUNNING_RECONCILE_MAX_CANDIDATES = 8;
const RUNNING_RECONCILE_INITIAL_BACKOFF_MS = 15_000;
const RUNNING_RECONCILE_MAX_BACKOFF_MS = 5 * 60_000;
const RUNNING_RECONCILE_MESSAGE_AGE_GATE_MS = 60_000;
const RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS = 5 * 60_000;
const CLOCK_ICON = "";
const TOKEN_ICON = "";
const SIDEBAR_ARROW_EXPANDED = "▼";
const SIDEBAR_ARROW_COLLAPSED = "▶";
const SUBAGENTS_EXPANDED_KV_KEY = "subagents.sidebar.expanded";
const SUBAGENTS_SECTION_ENABLED_KV_KEY = "subagents.sidebar.enabled";
const SUBAGENTS_MAX_VISIBLE_ROWS = 5;
const SUBAGENTS_RUNNING_ROW_HEIGHT = 3;
const SUBAGENTS_TERMINAL_ROW_HEIGHT = 2;
const SUBAGENTS_MODEL_ROW_HEIGHT = 1;
const SUBAGENTS_ROW_GAP = 0;
const SUBAGENTS_ROW_MARKER_WIDTH = SUBAGENT_TREE_ROW_PREFIX_COLUMNS;
const SUBAGENTS_MAX_LIST_HEIGHT =
  SUBAGENTS_MAX_VISIBLE_ROWS *
    (SUBAGENTS_RUNNING_ROW_HEIGHT + SUBAGENTS_MODEL_ROW_HEIGHT) +
  (SUBAGENTS_MAX_VISIBLE_ROWS - 1) * SUBAGENTS_ROW_GAP;
const INACTIVE_SUBAGENT_OPACITY = 0.65;
const SIDEBAR_VERSION_OPACITY = 0.7;
const SIDEBAR_FOCUS_INDICATOR = "●";

const packageRequire = createRequire(import.meta.url);

function readPluginVersion(): string | undefined {
  try {
    const metadata = packageRequire("../package.json") as { version?: unknown };
    return typeof metadata.version === "string" && metadata.version.length > 0
      ? metadata.version
      : undefined;
  } catch {
    return undefined;
  }
}

const PLUGIN_VERSION = readPluginVersion();

interface SidebarScrollRegistration {
  getScrollbox: () => ScrollBoxRenderable | undefined;
  getAnchor: () => SidebarScrollAnchor | undefined;
  getRows: () => readonly SidebarScrollRowLayout[];
  getLeadingHeight: () => number;
  offsetTop: number;
  anchor?: SidebarScrollAnchor;
  restoreFramesRemaining: number;
}

export interface SidebarScrollAnchor {
  childIDs: string[];
  intraRowOffset: number;
}

export interface SidebarScrollRowLayout {
  readonly id: string;
  readonly height: number;
}

interface SidebarListFocusRegistration {
  focusList: (preferredChildID?: string) => boolean;
  blurList: () => boolean;
  isListFocusModeActive: () => boolean;
}

interface SidebarCompletedHistoryRegistration {
  toggleCompletedHistory: () => boolean;
}

const sidebarScrollRegistrations = new Set<SidebarScrollRegistration>();
const sidebarListFocusRegistrations = new Set<SidebarListFocusRegistration>();
const sidebarCompletedHistoryRegistrations =
  new Set<SidebarCompletedHistoryRegistration>();
const SIDEBAR_SCROLL_RESTORE_FRAME_BUDGET = 2;

function focusVisibleSidebarSubagentList(preferredChildID?: string): boolean {
  for (const registration of [...sidebarListFocusRegistrations].reverse()) {
    if (registration.focusList(preferredChildID)) return true;
  }
  return false;
}

function blurVisibleSidebarSubagentList(): boolean {
  for (const registration of [...sidebarListFocusRegistrations].reverse()) {
    if (registration.blurList()) return true;
  }
  return false;
}

function isAnySidebarSubagentListFocused(): boolean {
  return [...sidebarListFocusRegistrations].some((registration) =>
    registration.isListFocusModeActive(),
  );
}

function toggleVisibleSidebarCompletedHistory(): boolean {
  for (const registration of [
    ...sidebarCompletedHistoryRegistrations,
  ].reverse()) {
    if (registration.toggleCompletedHistory()) return true;
  }
  return false;
}

function maxScrollTop(scrollbox: ScrollBoxRenderable): number {
  return Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height);
}

function clampedScrollTop(
  scrollbox: ScrollBoxRenderable,
  value: number,
): number {
  return Math.max(0, Math.min(value, maxScrollTop(scrollbox)));
}

function snapshotSidebarScrollOffsets(): void {
  for (const registration of sidebarScrollRegistrations) {
    const scrollbox = registration.getScrollbox();
    if (!scrollbox) continue;
    registration.offsetTop = clampedScrollTop(scrollbox, scrollbox.scrollTop);
    registration.anchor = registration.getAnchor();
    registration.restoreFramesRemaining = SIDEBAR_SCROLL_RESTORE_FRAME_BUDGET;
  }
}

function resolveSidebarAnchorScrollTop(input: {
  expanded: boolean;
  anchor?: SidebarScrollAnchor;
  rows: readonly SidebarScrollRowLayout[];
  leadingHeight: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}): { matched: boolean; offsetTop?: number; scrollTop?: number } {
  if (!input.expanded || !input.anchor || input.anchor.childIDs.length === 0) {
    return { matched: false };
  }

  let top = input.leadingHeight;
  const rowTops = new Map<string, number>();
  for (const row of input.rows) {
    rowTops.set(row.id, top);
    top += row.height + SUBAGENTS_ROW_GAP;
  }

  for (const [index, childID] of input.anchor.childIDs.entries()) {
    const rowTop = rowTops.get(childID);
    if (rowTop === undefined) continue;

    const desiredTop = rowTop + (index === 0 ? input.anchor.intraRowOffset : 0);
    const maxTop = Math.max(0, input.scrollHeight - input.viewportHeight);
    const nextTop = Math.max(0, Math.min(desiredTop, maxTop));
    return {
      matched: true,
      offsetTop: nextTop,
      scrollTop: input.scrollTop !== nextTop ? nextTop : undefined,
    };
  }

  return { matched: false };
}

export function preservedSidebarAnchorScrollTop(input: {
  expanded: boolean;
  anchor?: SidebarScrollAnchor;
  rows: readonly SidebarScrollRowLayout[];
  leadingHeight?: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}): number | undefined {
  return resolveSidebarAnchorScrollTop({
    ...input,
    leadingHeight: input.leadingHeight ?? 0,
  }).scrollTop;
}

export function preservedSidebarScrollTop(input: {
  expanded: boolean;
  offsetTop: number;
  anchor?: SidebarScrollAnchor;
  rows?: readonly SidebarScrollRowLayout[];
  leadingHeight?: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}): number | undefined {
  if (!input.expanded) return undefined;

  const anchorTop = resolveSidebarAnchorScrollTop({
    expanded: input.expanded,
    anchor: input.anchor,
    rows: input.rows ?? [],
    leadingHeight: input.leadingHeight ?? 0,
    scrollTop: input.scrollTop,
    scrollHeight: input.scrollHeight,
    viewportHeight: input.viewportHeight,
  });
  if (anchorTop.matched) return anchorTop.scrollTop;

  const maxTop = Math.max(0, input.scrollHeight - input.viewportHeight);
  const top = Math.max(0, Math.min(input.offsetTop, maxTop));
  return top > 0 && input.scrollTop !== top ? top : undefined;
}

type SidebarContentContext = TuiSlotContext & { session_id?: string };
type HomeBottomContext = TuiSlotContext;
type PromptRefProp =
  | ((ref: TuiPromptRef | undefined) => void)
  | { current?: TuiPromptRef | undefined }
  | undefined;
type HomePromptProps = {
  workspaceID?: string;
  workspace_id?: string;
  ref?: PromptRefProp;
  [key: string]: unknown;
};
type SessionPromptProps = {
  sessionID?: string;
  session_id?: string;
  right?: unknown;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  on_submit?: () => void;
  ref?: PromptRefProp;
  [key: string]: unknown;
};

export interface RunningReconcileCandidate extends RunningReconcileVersion {
  readonly source?: ChildSessionState["source"];
  readonly title?: string;
  readonly summary?: string;
  readonly agentName?: string;
  readonly startedMs: number;
  readonly updatedMs: number;
}

const DEBUG_LOG_DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
const DEBUG_LOG_MIN_MAX_BYTES = 16_384; // 16 KiB

function resolveDebugLogMaxBytes(): number {
  const raw = process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS_MAX_BYTES;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEBUG_LOG_DEFAULT_MAX_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < DEBUG_LOG_MIN_MAX_BYTES) {
    return DEBUG_LOG_DEFAULT_MAX_BYTES;
  }
  return parsed;
}

function resolveDebugLogPath(): string {
  return join(
    process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
    "opencode-subagent-statusline",
    "tui-events.log",
  );
}

let cachedDebugLogMaxBytes: number | undefined;

function debugLog(input: Record<string, unknown>): void {
  if (!process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS) return;
  try {
    const path = resolveDebugLogPath();
    const maxBytes =
      cachedDebugLogMaxBytes ??
      (cachedDebugLogMaxBytes = resolveDebugLogMaxBytes());
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...input })}\n`;
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    // appendFileSync's `mode` option only applies on creation; repair any
    // pre-existing file with a permissive mode.
    repairDebugLogMode(path);
    tryRotateDebugLog(path, maxBytes);
  } catch {
    // Debug logging must never crash the TUI.
  }
}

function repairDebugLogMode(path: string): void {
  try {
    const stats = statSync(path);
    if ((stats.mode & 0o777) === 0o600) return;
    chmodSync(path, 0o600);
  } catch {
    // Best-effort: if the file is missing or inaccessible, the next event
    // will retry.
  }
}

function tryRotateDebugLog(path: string, maxBytes: number): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (stats.size <= maxBytes) return;
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // Rotation is best-effort: if it fails, the next event will keep
    // appending until the next call or the file system refuses writes.
  }
}

function debugEvent(event: unknown): void {
  const e = event as {
    type?: unknown;
    properties?: { sessionID?: unknown; part?: unknown; info?: unknown };
  };
  const part = e.properties?.part as
    | { type?: unknown; tool?: unknown; state?: { status?: unknown } }
    | undefined;
  debugLog({
    kind: "event",
    type: e.type,
    sessionID: e.properties?.sessionID,
    partType: part?.type,
    tool: part?.tool,
    toolStatus: part?.state?.status,
  });
}

function cloneState(state: StatuslineState): StatuslineState {
  return {
    updatedAt: state.updatedAt,
    totalExecuted: state.totalExecuted,
    countedChildIDs: { ...state.countedChildIDs },
    children: Object.fromEntries(
      Object.entries(state.children).map(([id, child]) => [
        id,
        {
          ...child,
          tokens: child.tokens ? { ...child.tokens } : undefined,
          model: child.model ? { ...child.model } : undefined,
        },
      ]),
    ),
  };
}

function sameHydrationChild(
  left: ChildSessionState | undefined,
  right: ChildSessionState | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.summary === right.summary &&
    left.agentName === right.agentName &&
    left.parentID === right.parentID &&
    left.messageID === right.messageID &&
    left.source === right.source &&
    left.toolName === right.toolName &&
    left.targetSessionID === right.targetSessionID &&
    left.status === right.status &&
    left.color === right.color &&
    left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt &&
    left.endedAt === right.endedAt &&
    left.elapsedMs === right.elapsedMs &&
    sameTokens(left.tokens, right.tokens) &&
    sameChildModel(left.model, right.model)
  );
}

function changedHydrationChildIDs(
  before: StatuslineState,
  after: StatuslineState,
): string[] {
  const childIDs = new Set([
    ...Object.keys(before.children),
    ...Object.keys(after.children),
  ]);
  return [...childIDs].filter(
    (childID) =>
      !sameHydrationChild(
        before.children[childID],
        after.children[childID],
      ),
  );
}

function preserveFreshHydrationEvidence(
  hydrated: StatuslineState,
  current: StatuslineState,
  baseline: StatuslineState,
): void {
  for (const [childID, currentChild] of Object.entries(current.children)) {
    const baselineChild = baseline.children[childID];
    const statusChanged =
      currentChild.status !== baselineChild?.status ||
      currentChild.endedAt !== baselineChild?.endedAt;
    const modelChanged = !sameChildModel(
      currentChild.model,
      baselineChild?.model,
    );
    const tokensChanged = !sameTokens(
      currentChild.tokens,
      baselineChild?.tokens,
    );
    const metadataChanged =
      currentChild.title !== baselineChild?.title ||
      currentChild.summary !== baselineChild?.summary ||
      currentChild.agentName !== baselineChild?.agentName ||
      currentChild.parentID !== baselineChild?.parentID ||
      currentChild.messageID !== baselineChild?.messageID ||
      currentChild.source !== baselineChild?.source ||
      currentChild.toolName !== baselineChild?.toolName ||
      currentChild.targetSessionID !== baselineChild?.targetSessionID ||
      currentChild.startedAt !== baselineChild?.startedAt ||
      currentChild.updatedAt !== baselineChild?.updatedAt;
    let hydratedChild = hydrated.children[childID];

    if (!hydratedChild) {
      if (statusChanged || modelChanged || tokensChanged || metadataChanged) {
        hydrated.children[childID] = {
          ...currentChild,
          tokens: currentChild.tokens ? { ...currentChild.tokens } : undefined,
          model: currentChild.model ? { ...currentChild.model } : undefined,
        };
      }
      continue;
    }

    hydratedChild = {
      ...hydratedChild,
      title:
        currentChild.title !== baselineChild?.title
          ? currentChild.title
          : hydratedChild.title,
      summary:
        currentChild.summary !== baselineChild?.summary
          ? currentChild.summary
          : hydratedChild.summary,
      agentName:
        currentChild.agentName !== baselineChild?.agentName
          ? currentChild.agentName
          : hydratedChild.agentName,
      parentID:
        currentChild.parentID !== baselineChild?.parentID
          ? currentChild.parentID
          : hydratedChild.parentID,
      messageID:
        currentChild.messageID !== baselineChild?.messageID
          ? currentChild.messageID
          : hydratedChild.messageID,
      source:
        currentChild.source !== baselineChild?.source
          ? currentChild.source
          : hydratedChild.source,
      toolName:
        currentChild.toolName !== baselineChild?.toolName
          ? currentChild.toolName
          : hydratedChild.toolName,
      targetSessionID:
        currentChild.targetSessionID !== baselineChild?.targetSessionID
          ? currentChild.targetSessionID
          : hydratedChild.targetSessionID,
      startedAt:
        currentChild.startedAt !== baselineChild?.startedAt
          ? currentChild.startedAt
          : hydratedChild.startedAt,
      updatedAt:
        currentChild.updatedAt !== baselineChild?.updatedAt
          ? currentChild.updatedAt
          : hydratedChild.updatedAt,
    };
    if (statusChanged) {
      hydratedChild = {
        ...hydratedChild,
        status: currentChild.status,
        color: currentChild.color,
        updatedAt: currentChild.updatedAt,
        endedAt: currentChild.endedAt,
        elapsedMs: currentChild.elapsedMs,
      };
    }
    if (modelChanged) {
      hydratedChild = {
        ...hydratedChild,
        model: currentChild.model ? { ...currentChild.model } : undefined,
      };
    }
    if (hydratedChild.tokens) {
      hydratedChild = {
        ...hydratedChild,
        tokens: mergeFreshHydratedTokens(
          currentChild.tokens,
          baselineChild?.tokens,
          hydratedChild.tokens,
        ),
      };
    }
    hydrated.children[childID] = hydratedChild;
  }
}

function hasTokenTotal(tokens: ChildTokenState | undefined): boolean {
  return typeof tokens?.total === "number" && Number.isFinite(tokens.total);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeRead<Value>(read: () => Value): Value | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function messageIDOf(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) return undefined;
  const id = record.id ?? record.messageID ?? record.messageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function pushSessionCandidates(
  api: TuiPluginApi,
  sessionID: string | undefined,
  candidates: unknown[],
): void {
  if (!sessionID) return;

  const status = safeRead(() => api.state.session.status(sessionID));
  if (status) candidates.push(status);

  const messages = safeRead(() => api.state.session.messages(sessionID));
  if (!messages) return;

  candidates.push(messages);
  for (const message of messages) {
    const messageID = messageIDOf(message);
    if (!messageID) continue;
    const parts = safeRead(() => api.state.part(messageID));
    if (parts) candidates.push(parts);
  }
}

function hydrateChildTokensFromTuiState(
  api: TuiPluginApi,
  child: ChildSessionState,
): ChildTokenState | undefined {
  const candidates: unknown[] = [];

  pushSessionCandidates(api, child.id, candidates);

  if (child.messageID) {
    const parentParts = safeRead(() =>
      api.state.part(child.messageID as string),
    );
    if (parentParts) candidates.push(parentParts);

    const parentMessages = safeRead(() =>
      api.state.session.messages(child.parentID),
    );
    const parentMessage = parentMessages?.find(
      (message) => messageIDOf(message) === child.messageID,
    );
    if (parentMessage) candidates.push(parentMessage);
  }

  let tokens: ChildTokenState | undefined;
  for (const candidate of candidates) {
    tokens = mergeTokens(
      tokens,
      extractChildDetails(
        candidate as Parameters<typeof extractChildDetails>[0],
      ).tokens,
    );
  }

  return tokens;
}

async function hydrateChildTokensAsync(
  api: TuiPluginApi,
  child: ChildSessionState,
  signal?: AbortSignal,
): Promise<ChildTokenState | undefined> {
  let tokens = hydrateChildTokensFromTuiState(api, child);
  if (signal?.aborted) return undefined;

  if (!hasTokenTotal(tokens)) {
    const response = await safeReadAsync(() =>
      api.client.session.messages(
        {
          sessionID: child.id,
          directory: api.state.path.directory,
          limit: 50,
        },
        { signal },
      ),
    );
    const messages = Array.isArray(response?.data) ? response.data : [];
    for (const message of messages) {
      tokens = mergeTokens(
        tokens,
        extractChildDetails(message).tokens,
      );
      if (hasTokenTotal(tokens)) break;
    }
  }

  return signal?.aborted ? undefined : tokens;
}

export interface TuiPersistenceSnapshot {
  readonly state: StatuslineState;
  readonly changedChildIDs?: readonly string[];
}

export function combineTuiPersistenceSnapshots(
  accumulated: TuiPersistenceSnapshot,
  incoming: TuiPersistenceSnapshot,
): TuiPersistenceSnapshot {
  if (
    accumulated.changedChildIDs === undefined ||
    incoming.changedChildIDs === undefined
  ) {
    return { state: incoming.state };
  }
  return {
    state: incoming.state,
    changedChildIDs: [
      ...new Set([
        ...accumulated.changedChildIDs,
        ...incoming.changedChildIDs,
      ]),
    ],
  };
}

export function persistStateSnapshot(
  persistence: PersistenceCoordinator<TuiPersistenceSnapshot>,
  state: StatuslineState,
  flush = false,
  changedChildIDs?: readonly string[],
): Promise<void> {
  const snapshot: TuiPersistenceSnapshot = {
    state,
    ...(changedChildIDs !== undefined
      ? { changedChildIDs: [...changedChildIDs] }
      : {}),
  };
  return flush
    ? persistence.flush(snapshot)
    : persistence.request(snapshot);
}

function refreshLiveState(state: StatuslineState): boolean {
  const beforeChildIDs = new Set(Object.keys(state.children));
  refreshDerivedFields(state, undefined, (prunedCount, nowISO) => {
    debugLog({
      kind: "state.prune",
      prunedCount,
      now: nowISO,
    });
  });

  if (Object.keys(state.children).length !== beforeChildIDs.size) {
    return true;
  }

  for (const childID of beforeChildIDs) {
    if (!state.children[childID]) return true;
  }

  return false;
}

export function runTuiStateMaintenance(
  _api: TuiPluginApi,
  current: StatuslineState,
): StatuslineState {
  if (!isTerminalPruningDue(current)) return current;
  const next = cloneState(current);
  const refreshed = refreshLiveState(next);
  return refreshed ? next : current;
}

export function resolveTuiMaintenanceDemand(input: {
  readonly state: StatuslineState;
  readonly nowMs: number;
  readonly lastRunningReconcileAtMs: number;
  readonly hydratingSessionIDs?: ReadonlySet<string>;
}): {
  readonly prune: boolean;
  readonly reconcile: boolean;
  readonly hydrateTokens: boolean;
} {
  const reconciliationDue =
    input.nowMs - input.lastRunningReconcileAtMs >=
    RUNNING_RECONCILE_MAINTENANCE_INTERVAL_MS;
  const children = input.state.children;
  let reconcile = false;
  let hydrateTokens = false;

  // Iterate keys directly to avoid allocating an Object.values array on every
  // 2-second maintenance tick.
  for (const id in children) {
    const child = children[id];
    if (!child) continue;
    if (child.status === "running") {
      hydrateTokens = true;
      if (
        reconciliationDue &&
        !input.hydratingSessionIDs?.has(child.parentID)
      ) {
        reconcile = true;
      }
    } else if (!hasTokenTotal(child.tokens)) {
      hydrateTokens = true;
    }
    if (reconcile && hydrateTokens) break;
  }

  // Pruning check is a separate dedicated scan (isTerminalPruningDueAt),
  // but uses the millisecond timestamp directly to avoid a Date allocation.
  return {
    prune: isTerminalPruningDueAt(input.state, input.nowMs),
    reconcile,
    hydrateTokens,
  };
}

export function createTuiMaintenanceTimers(input: {
  onElapsedTick: () => void;
  onMaintenanceTick: () => void;
}): {
  syncElapsedTimer: (hasRunningChild: boolean) => void;
  dispose: () => void;
} {
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  const maintenanceTimer = setInterval(
    input.onMaintenanceTick,
    MAINTENANCE_TICK_MS,
  );

  return {
    syncElapsedTimer(hasRunningChild) {
      if (hasRunningChild && !elapsedTimer) {
        elapsedTimer = setInterval(input.onElapsedTick, ELAPSED_TICK_MS);
      } else if (!hasRunningChild && elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
      }
    },
    dispose() {
      if (elapsedTimer) clearInterval(elapsedTimer);
      clearInterval(maintenanceTimer);
      elapsedTimer = undefined;
    },
  };
}

function elapsedMs(child: ChildSessionState, nowMs: number): number {
  if (child.status !== "running") {
    return child.elapsedMs ?? 0;
  }
  const started = Date.parse(child.startedAt);
  if (Number.isNaN(started)) return child.elapsedMs ?? 0;
  return Math.max(0, nowMs - started);
}

function taskStatusMarker(status: ChildSessionState["status"]): string {
  if (status === "done") return "[✓]";
  if (status === "error") return "[x]";
  return "[ ]";
}

function statusColor(
  status: ChildSessionState["status"],
  theme: TuiThemeCurrent,
): TuiThemeCurrent["warning"] {
  if (status === "done") return theme.success;
  if (status === "error") return theme.error;
  return theme.warning;
}

function isSessionTarget(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("ses_");
}

function resolveChildTargetSessionID(
  child: ChildSessionState,
): string | undefined {
  if (isSessionTarget(child.targetSessionID)) {
    return child.targetSessionID;
  }
  if (child.id.startsWith("ses_")) {
    return child.id;
  }
  return undefined;
}

function resolveSyntheticTargetFromHydratedState(
  state: StatuslineState,
  synthetic: ChildSessionState,
  lookup = createChildLookup(state),
): string | undefined {
  return resolveSyntheticTargetSessionID(state, synthetic, [], lookup);
}

export function backfillHydratedTargetSessionIDs(
  state: StatuslineState,
  parentSessionID: string,
  options: {
    readonly lookup?: ChildLookup;
    readonly changedChildIDs?: Set<string>;
  } = {},
): boolean {
  let changed = false;
  const lookup = options.lookup ?? createChildLookup(state);

  for (const child of Object.values(state.children)) {
    if (child.parentID !== parentSessionID) continue;
    if (resolveChildTargetSessionID(child)) continue;
    if (child.source === "session" || child.id.startsWith("ses_")) {
      if (setChildTarget(state, child.id, child.id, lookup)) {
        options.changedChildIDs?.add(child.id);
        changed = true;
      }
      continue;
    }

    const syntheticTarget = resolveSyntheticTargetFromHydratedState(
      state,
      child,
      lookup,
    );
    if (syntheticTarget) {
      if (setChildTarget(state, child.id, syntheticTarget, lookup)) {
        options.changedChildIDs?.add(child.id);
        changed = true;
      }
    }
  }

  if (changed) {
    state.updatedAt = new Date().toISOString();
  }

  return changed;
}

function navigateToSessionTarget(
  api: TuiPluginApi,
  targetSessionID: string | undefined,
): void {
  if (!isSessionTarget(targetSessionID)) return;

  // Verified against local typings in `@opencode-ai/plugin/dist/tui.d.ts`:
  // api.route.navigate(name: string, params?: Record<string, unknown>)
  api.route.navigate("session", { sessionID: targetSessionID });
}

function toFinitePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function parseStaleRunningThresholdMs(): number {
  return parseConfiguredStaleRunningThresholdMs(
    process.env.OPENCODE_SUBAGENT_STATUSLINE_STALE_RUNNING_MS,
  );
}

const STALE_RUNNING_THRESHOLD_MS = parseStaleRunningThresholdMs();

function resolveSidebarWidth(ctx: unknown): number | undefined {
  const source = asRecord(ctx);
  if (!source) return undefined;

  const direct =
    toFinitePositiveInt(source.width) ??
    toFinitePositiveInt(source.columns) ??
    toFinitePositiveInt(source.cols);
  if (direct) return direct;

  const size = asRecord(source.size);
  const viewport = asRecord(source.viewport);
  const bounds = asRecord(source.bounds);

  return (
    toFinitePositiveInt(size?.width) ??
    toFinitePositiveInt(viewport?.width) ??
    toFinitePositiveInt(bounds?.width)
  );
}

function ellipsize(value: string, maxColumns: number): string {
  return truncateToColumns(value, maxColumns);
}

function splitParentheticalTitle(title: string): {
  label: string;
  parenthetical?: string;
} {
  const match = title.match(/^(.*?)\s*(\([^)]*\))\s*$/);
  if (!match) return { label: title };

  const label = match[1]?.trim();
  const parenthetical = match[2]?.trim();
  if (!label || !parenthetical) return { label: title };

  return { label, parenthetical };
}

function childParenthetical(child: ChildSessionState): string | undefined {
  if (child.agentName?.trim()) return `(${child.agentName.trim()})`;

  const primary = splitParentheticalTitle(childPrimaryText(child));
  if (primary.parenthetical) return primary.parenthetical;

  return splitParentheticalTitle(child.title).parenthetical;
}

function formatSecondaryLine(
  continuation: string | undefined,
  parenthetical: string | undefined,
  width: number,
): string | undefined {
  if (!continuation) {
    return parenthetical ? ellipsize(parenthetical, width) : undefined;
  }
  if (!parenthetical) return ellipsize(continuation, width);

  const parentheticalWidth = Math.min(textColumns(parenthetical), width);
  const continuationWidth = width - parentheticalWidth - 1;
  if (continuationWidth >= MIN_LABEL_WIDTH) {
    return `${ellipsize(continuation, continuationWidth)} ${ellipsize(parenthetical, parentheticalWidth)}`;
  }

  return ellipsize(parenthetical, width);
}

function childPrimaryText(child: ChildSessionState): string {
  return child.summary?.trim() || child.title;
}

function resolveTokenTotal(child: ChildSessionState): number | undefined {
  const total = child.tokens?.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }
  const input = child.tokens?.input;
  const output = child.tokens?.output;
  if (typeof input === "number" || typeof output === "number") {
    return Math.max(0, (input ?? 0) + (output ?? 0));
  }
  return undefined;
}

function contextVariants(child: ChildSessionState): string[] {
  const total = resolveTokenTotal(child);
  const percent = child.tokens?.contextPercent;
  const hasTotal = typeof total === "number" && Number.isFinite(total);
  const hasPercent = typeof percent === "number" && Number.isFinite(percent);

  if (!hasTotal && !hasPercent) return [""];

  const tokenPart = hasTotal ? formatCompactTokenCount(total) : "";
  const percentPart = hasPercent ? formatCompactPercentUsed(percent) : "";

  if (tokenPart && percentPart) {
    return [`${tokenPart} ${percentPart}`, percentPart, tokenPart, ""];
  }

  return [tokenPart || percentPart, ""];
}

function rowWidthBudget(sidebarWidth: number | undefined): number {
  const width = sidebarWidth ?? FALLBACK_SIDEBAR_WIDTH;
  const innerWidth = width - 4;
  return Math.max(MIN_ROW_WIDTH, Math.min(innerWidth, 52));
}

export function wrapCompactText(
  value: string,
  width: number,
  maxLines: number,
): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  let remaining = normalized;

  while (textColumns(remaining) > width && lines.length < maxLines - 1) {
    const probe = takeColumns(remaining, width + 1);
    const breakAt = probe.lastIndexOf(" ");
    const breakPrefix = breakAt >= 0 ? probe.slice(0, breakAt) : "";
    const fit = takeColumns(remaining, width);
    const take =
      breakAt >= 0 &&
      textColumns(breakPrefix) >= MIN_LABEL_WIDTH &&
      textColumns(breakPrefix) <= width
        ? breakAt
        : fit.length;
    if (take <= 0) break;

    lines.push(remaining.slice(0, take).trimEnd());
    remaining = remaining.slice(take).trimStart();
  }

  lines.push(
    lines.length === maxLines - 1
      ? ellipsize(remaining, Math.max(1, width))
      : remaining,
  );
  return lines;
}

function resolveSubagentTreeRowLayout(input: {
  readonly depth?: number;
  readonly sidebarWidth?: number;
  readonly reservedWidth?: number;
}) {
  return resolveTreeRowLayout({
    depth: input.depth ?? 0,
    rowWidth: rowWidthBudget(input.sidebarWidth),
    fixedColumns: input.reservedWidth ?? 0,
    minimumLabelWidth: MIN_LABEL_WIDTH,
  });
}

export function formatChildRowLine(input: {
  child: ChildSessionState;
  nowMs: number;
  depth?: number;
  sidebarWidth?: number;
  reservedWidth?: number;
}): {
  labelLines: string[];
  secondaryLine?: string;
  elapsed: string;
  meta: string;
  detailLine: string;
  labelWidth: number;
} {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const { labelWidth } = resolveSubagentTreeRowLayout(input);
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);
  const labelLines = wrapCompactText(title.label, labelWidth, 2);
  const meta =
    contextVariants(input.child).find((candidate) => {
      const detail = candidate
        ? `↳ ${CLOCK_ICON} ${elapsed} ${TOKEN_ICON} ${candidate}`
        : `↳ ${CLOCK_ICON} ${elapsed}`;
      return textColumns(detail) <= labelWidth;
    }) ?? "";
  const detail = meta
    ? `↳ ${CLOCK_ICON} ${elapsed} ${TOKEN_ICON} ${meta}`
    : `↳ ${CLOCK_ICON} ${elapsed}`;

  return {
    labelLines,
    secondaryLine: formatSecondaryLine(
      labelLines[1],
      parenthetical,
      labelWidth,
    ),
    elapsed,
    meta,
    detailLine: ellipsize(detail, labelWidth),
    labelWidth,
  };
}

export function formatTerminalChildRowLine(input: {
  child: ChildSessionState;
  nowMs: number;
  depth?: number;
  sidebarWidth?: number;
  reservedWidth?: number;
}): {
  label: string;
  detailLine: string;
} {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const { labelWidth } = resolveSubagentTreeRowLayout(input);
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);
  const labelSource = parenthetical
    ? `${title.label} ${parenthetical}`
    : title.label;
  const context =
    contextVariants(input.child).find((candidate) => {
      const detail = candidate
        ? `↳ ${CLOCK_ICON} ${elapsed} ${candidate}`
        : `↳ ${CLOCK_ICON} ${elapsed}`;
      return textColumns(detail) <= labelWidth;
    }) ?? "";
  const detail = context
    ? `↳ ${CLOCK_ICON} ${elapsed} ${context}`
    : `↳ ${CLOCK_ICON} ${elapsed}`;

  return {
    label: ellipsize(labelSource, labelWidth),
    detailLine: ellipsize(detail, labelWidth),
  };
}

export function subagentRowHeight(input: {
  child: ChildSessionState;
  nowMs: number;
  depth?: number;
  sidebarWidth?: number;
  reservedWidth?: number;
}): number {
  const modelHeight = input.child.model?.variant
    ? SUBAGENTS_MODEL_ROW_HEIGHT
    : 0;
  if (input.child.status !== "running") {
    return SUBAGENTS_TERMINAL_ROW_HEIGHT + modelHeight;
  }

  const line = formatChildRowLine(input);
  return (
    (line.secondaryLine
      ? SUBAGENTS_RUNNING_ROW_HEIGHT
      : SUBAGENTS_RUNNING_ROW_HEIGHT - 1) + modelHeight
  );
}

/**
 * Per-child cache of the layout-relevant row height. Terminal rows depend
 * only on `(status, hasModel)` so the result is stable for the lifetime of a
 * given `ChildSessionState` object and we can return the cached value without
 * recomputing on every elapsed-tick re-render. Running rows fall through to
 * {@link subagentRowHeight} (title-wrap depends on sidebar width, depth, and
 * the live `nowMs`).
 *
 * Evicted automatically when the child object is GC'd (WeakMap).
 */
const terminalRowHeightCache = new WeakMap<ChildSessionState, number>();

export function subagentRowHeightCached(input: {
  child: ChildSessionState;
  nowMs: number;
  depth?: number;
  sidebarWidth?: number;
  reservedWidth?: number;
}): number {
  if (input.child.status !== "running") {
    const cached = terminalRowHeightCache.get(input.child);
    if (cached !== undefined) return cached;
    const height = subagentRowHeight(input);
    terminalRowHeightCache.set(input.child, height);
    return height;
  }
  return subagentRowHeight(input);
}

/**
 * Variant of {@link subagentRowHeightCached} that lazily reads the `nowMs`
 * accessor only when a running row needs the time-dependent title-wrap path.
 * Lets layout memos track only the structural inputs (`visibleRows`,
 * `sidebarWidth`) and skip re-evaluation on the 1-second elapsed tick when no
 * running row's title actually re-wrapped.
 */
export function subagentRowHeightLazy(input: {
  child: ChildSessionState;
  readNowMs: () => number;
  depth?: number;
  sidebarWidth?: number;
  reservedWidth?: number;
}): number {
  if (input.child.status !== "running") {
    const cached = terminalRowHeightCache.get(input.child);
    if (cached !== undefined) return cached;
    const height = subagentRowHeight({
      ...input,
      nowMs: input.readNowMs(),
    });
    terminalRowHeightCache.set(input.child, height);
    return height;
  }
  return subagentRowHeight({
    ...input,
    nowMs: input.readNowMs(),
  });
}

export function formatChildModelLine(
  child: ChildSessionState,
  providers: TuiPluginApi["state"]["provider"],
  width: number,
): string | undefined {
  if (!child.model?.variant) return undefined;
  const provider = providers.find(
    (candidate) => candidate.id === child.model?.providerID,
  );
  const name = provider?.models[child.model.modelID]?.name || child.model.modelID;
  return ellipsize(`${name} · ${child.model.variant}`, Math.max(1, width));
}

export interface TuiSubagentSnapshot {
  readonly visibleRows: readonly SubagentTreeRow[];
  readonly visibleCounts: StatusCounts;
  readonly totalExecuted: number;
  readonly showingOtherSessions: false;
  readonly descendantSessionIDs: ReadonlySet<string>;
}

export function resolveTuiSubagentSnapshot(input: {
  readonly state: StatuslineState;
  readonly sessionID?: string;
  readonly nowMs?: number;
  readonly showCompletedHistory?: boolean;
  readonly currentRouteProjection?: CurrentRouteSubtreeProjection;
}): TuiSubagentSnapshot {
  // Note: `filterVisibleFromCanonical` accepts an options bag, but with one
  // boolean field inlining the call is just as clear and skips an object
  // allocation per snapshot. The visibility options are not shared across
  // calls, so a fresh conditional is cheaper than constructing an object.
  const nowMs = input.nowMs ?? Date.now();
  const showCompletedHistory = input.showCompletedHistory;
  if (input.sessionID) {
    const subtree =
      input.currentRouteProjection?.state === input.state &&
      input.currentRouteProjection.sessionID === input.sessionID
        ? input.currentRouteProjection.subtree
        : buildCurrentRouteSubtreeProjection(input.state, input.sessionID).subtree;
    const visibleChildren = new Set(
      showCompletedHistory
        ? [...subtree.canonicalRows]
        : filterVisibleFromCanonical([...subtree.canonicalRows], nowMs, {
            showCompletedHistory,
          }),
    );
    let totalExecuted = 0;
    for (const executionID of subtree.executionIDs) {
      if (input.state.countedChildIDs[executionID]) totalExecuted += 1;
    }

    return {
      visibleRows: subtree.rows.filter(({ child }) => visibleChildren.has(child)),
      visibleCounts: subtree.retainedCounts,
      totalExecuted,
      showingOtherSessions: false,
      descendantSessionIDs: subtree.executionIDs,
    };
  }

  const projection = buildSubagentProjection(input.state);
  const visibleChildren = (showCompletedHistory
    ? projection.canonicalRows
    : filterVisibleFromCanonical(projection.canonicalRows, nowMs, {
        showCompletedHistory,
      })
  ).sort(byPriority);
  return {
    visibleRows: visibleChildren.map((child) => ({
      child,
      depth: 0,
      parentSessionID: child.parentID,
    })),
    visibleCounts: projection.retainedCounts,
    totalExecuted: projection.totalExecuted,
    showingOtherSessions: false,
    descendantSessionIDs: new Set(projection.orderedExecutionIDs),
  };
}

export function resolveSidebarSubagentSnapshot(input: {
  readonly state: StatuslineState;
  readonly sessionID: string;
  readonly nowMs?: number;
  readonly showCompletedHistory?: boolean;
  readonly currentRouteProjection?: CurrentRouteSubtreeProjection;
}): TuiSubagentSnapshot {
  return resolveTuiSubagentSnapshot(input);
}

function SidebarSubagents(props: {
  api: TuiPluginApi;
  sessionID: string;
  state: () => StatuslineState;
  nowMs: () => number;
  expanded: () => boolean;
  onToggleExpanded: () => void;
  onSetExpanded: (expanded: boolean) => void;
  onReturnFocus: () => void;
  onToggleListFocus: () => void;
  onNavigateToChild: (input: {
    parentSessionID: string;
    childSessionID: string;
    childRowID: string;
    showCompletedHistory: boolean;
  }) => void;
  sidebarWidth?: () => number | undefined;
  theme: TuiThemeCurrent;
  restoreFromChild?: {
    childRowID: string;
    showCompletedHistory: boolean;
  };
  currentRouteProjection?: () => CurrentRouteSubtreeProjection | undefined;
}) {
  const [showCompletedHistory, setShowCompletedHistory] = createSignal(
    props.restoreFromChild?.showCompletedHistory ?? false,
  );
  const completedHistoryOptions = () => ({
    showCompletedHistory: showCompletedHistory(),
  });
  const snapshot = createMemo(() => {
    const state = props.state();
    return resolveSidebarSubagentSnapshot({
      state,
      sessionID: props.sessionID,
      nowMs: props.nowMs(),
      currentRouteProjection: props.currentRouteProjection?.(),
      ...completedHistoryOptions(),
    });
  });
  const visibleRows = createMemo(() => snapshot().visibleRows);
  const counts = createMemo(() => snapshot().visibleCounts);
  const totalExecuted = createMemo(() => snapshot().totalExecuted);

  const visibleChildIDs = createMemo(() =>
    visibleRows().map(({ child }) => child.id),
  );
  const visibleChildByID = createMemo(
    () => new Map(visibleRows().map((row) => [row.child.id, row])),
  );
  const [selectedChildID, setSelectedChildID] = createSignal<
    string | undefined
  >(props.restoreFromChild?.childRowID);
  let restoreChildRowID = props.restoreFromChild?.childRowID;
  const [mouseDownChildID, setMouseDownChildID] = createSignal<
    string | undefined
  >();
  const [listFocused, setListFocused] = createSignal(false);
  const [listFocusModeActive, setListFocusModeActive] = createSignal(false);

  const visibleChildLayoutSignature = createMemo(() => {
    return treeRowsLayoutSignature(visibleRows());
  });

  const rowLayoutIndex = createMemo(() => {
    const sidebarWidth = props.sidebarWidth?.();
    return buildSidebarRowLayoutIndex(
      visibleRows().map(({ child, depth }) => ({
        id: child.id,
        height: subagentRowHeightLazy({
          child,
          depth,
          readNowMs: props.nowMs,
          sidebarWidth,
          reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
        }),
      })),
      SUBAGENTS_ROW_GAP,
    );
  });

  const [rowWindowScrollTop, setRowWindowScrollTop] = createSignal(0);
  const [rowWindowViewportHeight, setRowWindowViewportHeight] = createSignal(
    SUBAGENTS_MAX_LIST_HEIGHT,
  );
  const mountedRowWindow = createMemo(() =>
    resolveSidebarRowWindow(
      rowLayoutIndex(),
      rowWindowScrollTop(),
      rowWindowViewportHeight(),
    ),
  );
  const mountedChildIDs = createMemo(() =>
    mountedRowWindow().rows.map((row) => row.id),
  );

  let listContainer: BoxRenderable | undefined;
  let scrollbox: ScrollBoxRenderable | undefined;
  const scrollRegistration: SidebarScrollRegistration = {
    getScrollbox: () => scrollbox,
    getAnchor: () => currentSidebarScrollAnchor(),
    getRows: () => rowLayouts(),
    getLeadingHeight: () => 0,
    offsetTop: 0,
    restoreFramesRemaining: 0,
  };
  sidebarScrollRegistrations.add(scrollRegistration);
  const focusRegistration: SidebarListFocusRegistration = {
    focusList: (preferredChildID?: string) => {
      if (!listContainer) return false;
      const layout = rowLayoutIndex();
      if (preferredChildID && layout.rowByID.has(preferredChildID)) {
        setSelectedChildID(preferredChildID);
      } else if (!selectedChildID() && layout.rows[0]) {
        setSelectedChildID(layout.rows[0].id);
      }
      listContainer.focus();
      setListFocused(true);
      setListFocusModeActive(true);
      return true;
    },
    blurList: () => {
      if (!listFocused() && !listFocusModeActive()) return false;
      listContainer?.blur();
      setListFocused(false);
      setListFocusModeActive(false);
      return true;
    },
    isListFocusModeActive: () => listFocusModeActive(),
  };
  sidebarListFocusRegistrations.add(focusRegistration);
  let previousRunningCount: number | undefined;
  createEffect(() => {
    const runningCount = counts().running;
    const shouldReleaseFocus = shouldReleaseSidebarListFocus({
      previousRunningCount,
      runningCount,
      listFocusModeActive: listFocusModeActive(),
    });
    previousRunningCount = runningCount;
    if (!shouldReleaseFocus) return;

    focusRegistration.blurList();
    props.onReturnFocus();
  });
  const completedHistoryRegistration: SidebarCompletedHistoryRegistration = {
    toggleCompletedHistory: () => {
      setShowCompletedHistory((current) => !current);
      return true;
    },
  };
  sidebarCompletedHistoryRegistrations.add(completedHistoryRegistration);
  onCleanup(() => {
    sidebarScrollRegistrations.delete(scrollRegistration);
    sidebarListFocusRegistrations.delete(focusRegistration);
    sidebarCompletedHistoryRegistrations.delete(completedHistoryRegistration);
  });

  createEffect(() => {
    const layout = rowLayoutIndex();
    const current = selectedChildID();
    const next = resolveSidebarSelectedRowID(layout, current);
    if (next !== current) setSelectedChildID(next);
  });

  const refreshListFocused = (): void => {
    if (listFocused() && !listContainer) {
      setListFocused(false);
      return;
    }
    const focused = Boolean(
      listContainer?.focused || listContainer?.hasFocusedDescendant,
    );
    if (!focused && listFocused()) setListFocused(false);
  };

  const refreshMountedWindowViewport = (): void => {
    const nextScrollTop = scrollbox
      ? clampedScrollTop(scrollbox, scrollbox.scrollTop)
      : 0;
    const nextViewportHeight = Math.max(
      1,
      scrollbox?.viewport.height ?? rowLayoutIndex().listHeight,
    );
    if (rowWindowScrollTop() !== nextScrollTop) {
      setRowWindowScrollTop(nextScrollTop);
    }
    if (rowWindowViewportHeight() !== nextViewportHeight) {
      setRowWindowViewportHeight(nextViewportHeight);
    }
  };

  const rowTopForIndex = (index: number): number => {
    return rowLayoutIndex().rows[index]?.top ?? 0;
  };

  const rowLayouts = (): readonly SidebarScrollRowLayout[] =>
    rowLayoutIndex().rows;

  const currentSidebarScrollAnchor = (): SidebarScrollAnchor | undefined => {
    if (!scrollbox) return undefined;
    const layout = rowLayoutIndex();
    const rows = layout.rows;
    if (rows.length === 0) return undefined;

    const viewportTop = clampedScrollTop(scrollbox, scrollbox.scrollTop);
    const firstVisibleIndex = resolveSidebarRowWindow(
      layout,
      viewportTop,
      rowLayoutIndex().listHeight,
    ).visibleStartIndex;
    const firstVisibleRow = rows[firstVisibleIndex];
    if (!firstVisibleRow) return undefined;
    return {
      childIDs: rows
        .slice(firstVisibleIndex)
        .map((candidate) => candidate.id),
      intraRowOffset: Math.max(0, viewportTop - firstVisibleRow.top),
    };
  };

  const scrollChildIntoView = (childID: string | undefined): void => {
    if (!scrollbox) return;
    const selectedRow = childID
      ? rowLayoutIndex().rowByID.get(childID)
      : undefined;
    if (!selectedRow) return;

    const rowTop = rowTopForIndex(selectedRow.index);
    const rowBottom = selectedRow.bottom;
    const viewportTop = scrollbox.scrollTop;
    const viewportBottom = viewportTop + rowLayoutIndex().listHeight;

    if (rowTop < viewportTop) {
      const nextTop = clampedScrollTop(scrollbox, rowTop);
      scrollRegistration.offsetTop = nextTop;
      scrollbox.scrollTop = nextTop;
    } else if (rowBottom > viewportBottom) {
      const nextTop = clampedScrollTop(scrollbox, rowBottom - rowLayoutIndex().listHeight);
      scrollRegistration.offsetTop = nextTop;
      scrollbox.scrollTop = nextTop;
    }
    refreshMountedWindowViewport();
  };

  const scrollSelectedChildIntoView = (): void => {
    if (!listFocusModeActive()) return;
    scrollChildIntoView(selectedChildID());
  };

  const moveSelection = (delta: number): void => {
    const nextID = moveSidebarRowSelection(
      rowLayoutIndex(),
      selectedChildID(),
      delta,
    );
    if (!nextID) return;
    setSelectedChildID(nextID);
    scrollChildIntoView(nextID);
  };

  const rowActivations = new Map<string, () => void>();

  const selectedTargetSessionID = (): string | undefined => {
    const selectedID = selectedChildID();
    const selectedRow = selectedID
      ? visibleChildByID().get(selectedID)
      : undefined;
    return selectedRow
      ? resolveSubagentTreeRowTargetSessionID(selectedRow)
      : undefined;
  };

  const activateRow = (row: SubagentTreeRow): void => {
    activateSubagentTreeRow({
      row,
      showCompletedHistory: showCompletedHistory(),
      remember: props.onNavigateToChild,
      navigate: (targetSessionID) => {
        snapshotSidebarScrollOffsets();
        navigateToSessionTarget(props.api, targetSessionID);
      },
    });
  };

  const activateSelectedChild = (): void => {
    activateSidebarSelection({
      selectedRowID: selectedChildID(),
      mountedActivations: rowActivations,
      targetSessionID: selectedTargetSessionID(),
      navigate: (targetSessionID) => {
        const selectedID = selectedChildID();
        const selectedRow = selectedID
          ? visibleChildByID().get(selectedID)
          : undefined;
        if (selectedRow) {
          activateRow(selectedRow);
          return;
        }
        navigateToSessionTarget(props.api, targetSessionID);
      },
    });
  };

  const toggleCompletedHistory = (): void => {
    completedHistoryRegistration.toggleCompletedHistory();
  };

  createEffect(() => {
    selectedChildID();
    rowLayoutIndex().listHeight;
    if (!listFocused()) return;
    scrollSelectedChildIntoView();
  });

  const handleListKeyDown = (event: KeyEvent): void => {
    if (!listFocused()) return;
    const name = event.name.toLowerCase();
    if ((event.meta || event.option) && name === "b") {
      props.onToggleListFocus();
    } else if (name === "j" || name === "down" || name === "arrowdown") {
      moveSelection(1);
    } else if (name === "k" || name === "up" || name === "arrowup") {
      moveSelection(-1);
    } else if (name === "return" || name === "enter") {
      activateSelectedChild();
    } else if (name === "h" || name === "left" || name === "arrowleft") {
      if (props.expanded()) props.onSetExpanded(false);
    } else if (name === "l" || name === "right" || name === "arrowright") {
      if (!props.expanded()) props.onSetExpanded(true);
    } else if (name === "c") {
      toggleCompletedHistory();
    } else if (name === "escape" || name === "esc") {
      focusRegistration.blurList();
      props.onReturnFocus();
    } else {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };

  useKeyboard(handleListKeyDown);

  const restorePreservedScroll = (): void => {
    if (!scrollbox) return;
    if (scrollRegistration.restoreFramesRemaining <= 0) return;
    scrollRegistration.restoreFramesRemaining -= 1;

    if (restoreChildRowID) {
      const childRowID = restoreChildRowID;
      restoreChildRowID = undefined;
      scrollRegistration.restoreFramesRemaining = 0;
      if (rowLayoutIndex().rowByID.has(childRowID)) {
        scrollChildIntoView(childRowID);
      } else {
        scrollbox.scrollTop = 0;
        refreshMountedWindowViewport();
      }
      return;
    }

    const top = preservedSidebarScrollTop({
      expanded: props.expanded(),
      offsetTop: scrollRegistration.offsetTop,
      anchor: scrollRegistration.anchor,
      rows: scrollRegistration.getRows(),
      leadingHeight: scrollRegistration.getLeadingHeight(),
      scrollTop: scrollbox.scrollTop,
      scrollHeight: scrollbox.scrollHeight,
      viewportHeight: scrollbox.viewport.height,
    });
    if (top === undefined) return;
    scrollRegistration.offsetTop = top;
    scrollbox.scrollTop = top;
  };

  createEffect(() => {
    props.expanded();
    visibleChildIDs().join("|");
    visibleChildLayoutSignature();
    props.sidebarWidth?.();

    restorePreservedScroll();
  });

  const ChildRow = (rowProps: { childID: string }) => {
    const row = createMemo(() => visibleChildByID().get(rowProps.childID));
    const child = createMemo(() => row()?.child);
    const [hovered, setHovered] = createSignal(false);
    const [focused, setFocused] = createSignal(false);
    const targetSessionID = createMemo(() => {
      const currentRow = row();
      return currentRow
        ? resolveSubagentTreeRowTargetSessionID(currentRow)
        : undefined;
    });
    const clickable = createMemo(() => isSessionTarget(targetSessionID()));
    const selected = createMemo(
      () => listFocused() && selectedChildID() === rowProps.childID,
    );
    const emphasized = createMemo(
      () => clickable() && (hovered() || focused() || selected()),
    );
    const status = createMemo<ChildSessionState["status"]>(
      () => child()?.status ?? "running",
    );
    const muted = createMemo(
      () => status() !== "running" && clickable() && !emphasized(),
    );
    const rowOpacity = createMemo(() =>
      status() === "running" ? 1 : INACTIVE_SUBAGENT_OPACITY,
    );
    const line = createMemo<ReturnType<typeof formatChildRowLine>>(() => {
      const currentChild = child();
      if (!currentChild) {
        return {
          labelLines: [""],
          elapsed: "00:00",
          meta: "",
          detailLine: "↳  00…",
          labelWidth: MIN_LABEL_WIDTH,
        };
      }
      return formatChildRowLine({
        child: currentChild,
        depth: row()?.depth,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
      });
    });
    const terminalLine = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return { label: "", detailLine: "↳  00…" };
      return formatTerminalChildRowLine({
        child: currentChild,
        depth: row()?.depth,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
      });
    });
    const rowHeight = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return SUBAGENTS_TERMINAL_ROW_HEIGHT;
      return subagentRowHeightCached({
        child: currentChild,
        depth: row()?.depth,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
      });
    });
    const modelLine = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return undefined;
      return formatChildModelLine(
        currentChild,
        props.api.state.provider,
        resolveSubagentTreeRowLayout({
          depth: row()?.depth,
          sidebarWidth: props.sidebarWidth?.(),
          reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
        }).labelWidth,
      );
    });
    const activate = () => {
      const currentRow = row();
      if (currentRow) activateRow(currentRow);
    };
    rowActivations.set(rowProps.childID, activate);
    onCleanup(() => {
      rowActivations.delete(rowProps.childID);
    });
    const handleKeyDown = (event: KeyEvent): void => {
      if (!clickable()) return;
      setFocused(true);
      if (event.name === "return" || event.name === "space") {
        activate();
        event.preventDefault();
        event.stopPropagation();
      }
    };

    return (
      <box
        id={rowProps.childID}
        flexDirection="column"
        flexShrink={0}
        height={rowHeight()}
        paddingLeft={
          resolveSubagentTreeRowLayout({
            depth: row()?.depth,
            sidebarWidth: props.sidebarWidth?.(),
            reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
          }).indentColumns
        }
        opacity={rowOpacity()}
        backgroundColor={selected() ? props.theme.backgroundElement : undefined}
        onMouseOver={clickable() ? () => setHovered(true) : undefined}
        onMouseOut={
          clickable()
            ? () => {
                setHovered(false);
                setFocused(false);
                setMouseDownChildID(undefined);
              }
            : undefined
        }
        onMouseDown={
          clickable()
            ? (event: MouseEvent) => {
                event.stopPropagation();
                setSelectedChildID(rowProps.childID);
                setMouseDownChildID(rowProps.childID);
              }
            : undefined
        }
        onMouseUp={
          clickable()
            ? (event: MouseEvent) => {
                if (mouseDownChildID() === rowProps.childID) {
                  event.stopPropagation();
                  activate();
                }
                setMouseDownChildID(undefined);
              }
            : undefined
        }
        onKeyDown={clickable() ? handleKeyDown : undefined}
        focusable={clickable()}
        focused={clickable() && focused()}
      >
        <Show
          when={status() === "running"}
          fallback={
            <box flexDirection="column">
              <box flexDirection="row">
                <text
                  fg={selected() ? props.theme.accent : props.theme.textMuted}
                >
                  {selected() ? "›" : " "}
                </text>
                <text fg={statusColor(status(), props.theme)}>
                  {taskStatusMarker(status())}
                </text>
                <text
                  fg={
                    selected()
                      ? props.theme.text
                      : muted()
                        ? props.theme.textMuted
                        : props.theme.text
                  }
                >{` ${terminalLine().label}`}</text>
              </box>
              <text
                fg={emphasized() ? props.theme.text : props.theme.textMuted}
              >{`${" ".repeat(SUBAGENTS_ROW_MARKER_WIDTH)}${terminalLine().detailLine}`}</text>
              <Show when={modelLine()}>
                {(metadata: Accessor<string>) => (
                  <text
                    fg={props.theme.textMuted}
                  >{`${" ".repeat(SUBAGENTS_ROW_MARKER_WIDTH)}${metadata()}`}</text>
                )}
              </Show>
            </box>
          }
        >
          <box flexDirection="column">
            <box flexDirection="row">
              <text
                fg={selected() ? props.theme.accent : props.theme.textMuted}
              >
                {selected() ? "›" : " "}
              </text>
              <text fg={statusColor(status(), props.theme)}>
                {taskStatusMarker(status())}
              </text>
              <text
                fg={
                  selected()
                    ? props.theme.text
                    : muted()
                      ? props.theme.textMuted
                      : props.theme.text
                }
              >{` ${line().labelLines[0] ?? ""}`}</text>
            </box>
            <Show when={line().secondaryLine}>
              {(secondaryLine: Accessor<string>) => (
                <text
                  fg={muted() ? props.theme.textMuted : props.theme.text}
                >{`${" ".repeat(SUBAGENTS_ROW_MARKER_WIDTH)}${secondaryLine()}`}</text>
              )}
            </Show>
            <box
              flexDirection="row"
              paddingLeft={SUBAGENTS_ROW_MARKER_WIDTH}
            >
              <text
                fg={emphasized() ? props.theme.text : props.theme.textMuted}
              >{line().detailLine}</text>
            </box>
            <Show when={modelLine()}>
              {(metadata: Accessor<string>) => (
                <text
                  fg={props.theme.textMuted}
                >{`${" ".repeat(SUBAGENTS_ROW_MARKER_WIDTH)}${metadata()}`}</text>
              )}
            </Show>
          </box>
        </Show>
      </box>
    );
  };

  const AggregateBar = () => (
    <box flexDirection="row" paddingRight={1}>
      <text fg={props.theme.warning}>{`● ${counts().running} run`}</text>
      <text fg={props.theme.textMuted}> · </text>
      <text fg={props.theme.success}>{`✓ ${counts().done} done`}</text>
      <text fg={props.theme.textMuted}> · </text>
      <text fg={props.theme.error}>{`✕ ${counts().error} err`}</text>
      <text fg={props.theme.textMuted}> · </text>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text supports mouse targets. */}
      <text
        fg={showCompletedHistory() ? props.theme.accent : props.theme.text}
        selectable={false}
        onMouseDown={toggleCompletedHistory}
      >{`Σ ${totalExecuted()}`}</text>
    </box>
  );

  return (
    <box
      ref={(element) => {
        listContainer = element;
        if (!element) setListFocused(false);
      }}
      flexDirection="column"
      backgroundColor={listFocused() ? props.theme.backgroundPanel : undefined}
      focusable
      focused={listFocused()}
      renderBefore={() => {
        refreshListFocused();
        restorePreservedScroll();
        refreshMountedWindowViewport();
      }}
    >
      <box flexDirection="row">
        <text
          fg={props.theme.text}
          selectable={false}
          onMouseDown={props.onToggleExpanded}
        >{`${props.expanded() ? SIDEBAR_ARROW_EXPANDED : SIDEBAR_ARROW_COLLAPSED} ${t("subagents")}`}</text>
        <Show when={PLUGIN_VERSION}>
          {(version: Accessor<string>) => (
            <box flexDirection="row">
              <text
                fg={props.theme.textMuted}
                opacity={SIDEBAR_VERSION_OPACITY}
                selectable={false}
                onMouseDown={props.onToggleExpanded}
              >{` ${version()}`}</text>
              <Show when={listFocused()}>
                <text
                  fg={props.theme.accent}
                  selectable={false}
                  onMouseDown={props.onToggleExpanded}
                >{` ${SIDEBAR_FOCUS_INDICATOR}`}</text>
              </Show>
            </box>
          )}
        </Show>
      </box>
      <AggregateBar />

      <Show when={props.expanded()}>
        <scrollbox
          ref={(element) => {
            scrollbox = element;
            restorePreservedScroll();
            refreshMountedWindowViewport();
          }}
          height={rowLayoutIndex().listHeight}
          scrollY
          viewportCulling={true}
          contentOptions={{ flexDirection: "column" }}
        >
          <Show when={mountedRowWindow().beforeHeight > 0}>
            <box
              height={mountedRowWindow().beforeHeight}
              flexShrink={0}
            />
          </Show>
          <For each={mountedChildIDs()}>
            {(childID: string) => {
              const geometry = createMemo(() =>
                rowLayoutIndex().rowByID.get(childID),
              );
              return (
                <box
                  flexDirection="column"
                  flexShrink={0}
                  height={
                    (geometry()?.height ?? 1) + (geometry()?.gapAfter ?? 0)
                  }
                >
                  <ChildRow childID={childID} />
                </box>
              );
            }}
          </For>
          <Show when={mountedRowWindow().afterHeight > 0}>
            <box height={mountedRowWindow().afterHeight} flexShrink={0} />
          </Show>
        </scrollbox>
      </Show>
    </box>
  );
}

function HomeBottomStatus(props: {
  state: () => StatuslineState;
  theme: TuiThemeCurrent;
}) {
  const snapshot = createMemo(() =>
    resolveTuiSubagentSnapshot({ state: props.state() }),
  );
  const counts = createMemo(() => snapshot().visibleCounts);
  const totalExecuted = createMemo(() => snapshot().totalExecuted);
  const visible = createMemo(
    () => counts().running > 0 || counts().error > 0 || totalExecuted() > 0,
  );

  return (
    <Show when={visible()}>
      <box paddingLeft={1} paddingRight={1}>
        <box flexDirection="row">
          <text fg={props.theme.warning}>{`● ${counts().running}`}</text>
          <text fg={props.theme.textMuted}> · </text>
          <text fg={props.theme.success}>{`✓ ${counts().done}`}</text>
          <text fg={props.theme.textMuted}> · </text>
          <text fg={props.theme.error}>{`✕ ${counts().error}`}</text>
          <text fg={props.theme.textMuted}> · </text>
          <text fg={props.theme.text}>{`Σ ${totalExecuted()}`}</text>
        </box>
      </box>
    </Show>
  );
}

export interface RouteHydrationApi {
  readonly state: { readonly path: { readonly directory: string } };
  readonly client: {
    readonly session?: {
      readonly children?: (
        input: { readonly sessionID: string; readonly directory: string },
        options?: { readonly signal?: AbortSignal },
      ) => Promise<{ readonly data?: unknown }>;
      readonly messages?: (
        input: {
          readonly sessionID: string;
          readonly directory: string;
          readonly limit?: number;
        },
        options?: { readonly signal?: AbortSignal },
      ) => Promise<{ readonly data?: unknown }>;
      readonly status?: (
        input: { readonly directory: string },
        options?: { readonly signal?: AbortSignal },
      ) => Promise<{ readonly data?: unknown }>;
    };
  };
}

export interface RouteHydrationOptions {
  readonly signal?: AbortSignal;
  readonly isValid?: () => boolean;
  readonly getCurrentState?: () => StatuslineState;
}

export interface RouteHydrationRequest {
  readonly api: RouteHydrationApi;
  readonly currentSessionID: string;
  readonly statePath: string;
  readonly textPath: string;
  readonly setState: (
    update: (previous: StatuslineState) => StatuslineState,
  ) => void;
  readonly persistenceCoordinator?: PersistenceCoordinator<TuiPersistenceSnapshot>;
  readonly options?: RouteHydrationOptions;
}

type RouteMessageEvidence = SessionMessageSummary & {
  readonly messages: readonly unknown[];
  readonly fetchFailed: boolean;
  readonly model?: ReturnType<typeof extractLatestAssistantModel>;
  readonly tokens?: ChildTokenState;
};

class RouteHydrationReadError extends Error {
  readonly resource: "children";

  constructor() {
    super("Route hydration children response is unavailable or unsupported");
    this.name = "RouteHydrationReadError";
    this.resource = "children";
  }
}

export async function hydratePreviousSubagents(
  request: RouteHydrationRequest,
): Promise<boolean> {
  const {
    api,
    currentSessionID,
    statePath,
    textPath,
    setState,
    persistenceCoordinator,
  } = request;
  const options = request.options ?? {};
  if (!currentSessionID) return false;

  const routeController = new AbortController();
  const abortRoute = (): void => routeController.abort();
  options.signal?.addEventListener("abort", abortRoute, { once: true });
  const isValid = (): boolean => {
    if (
      options.signal?.aborted === true ||
      !(options.isValid?.() ?? true)
    ) {
      routeController.abort();
    }
    return !routeController.signal.aborted;
  };
  if (!isValid()) {
    options.signal?.removeEventListener("abort", abortRoute);
    return false;
  }

  try {
    const persistence =
      persistenceCoordinator ??
      createPersistenceCoordinator<TuiPersistenceSnapshot>(
        async ({ state, changedChildIDs }) => {
          const prepared = await saveState(statePath, state, {
            ...(changedChildIDs !== undefined ? { changedChildIDs } : {}),
          });
          await saveStatusText(textPath, renderStatusLine(prepared));
        },
        { combineSnapshots: combineTuiPersistenceSnapshots },
      );
    const directory = api.state.path.directory;
    const sessionClient = api.client.session;
    const currentState = options.getCurrentState?.();
    const hydrationBaseline = currentState
      ? cloneState(currentState)
      : undefined;
    const statusResultPromise = (async (): Promise<{
      readonly statuses: Record<string, unknown>;
      readonly failed: boolean;
    }> => {
      const readStatus = sessionClient?.status;
      if (!readStatus) return { statuses: {}, failed: true };
      const response = await raceRouteAbort(
        () =>
          safeReadAsync(() =>
            readStatus(
              { directory },
              { signal: routeController.signal },
            ),
          ),
        routeController.signal,
      );
      isValid();
      const statuses = asRecord(response?.data);
      return statuses && !Array.isArray(response?.data)
        ? { statuses, failed: false }
        : { statuses: {}, failed: !routeController.signal.aborted };
    })();
    const discovery = await discoverDescendantSessions({
      rootSessionID: currentSessionID,
      directory,
      signal: routeController.signal,
      readChildren: async (parentSessionID) => {
        if (!isValid()) return [];
        const readChildren = sessionClient?.children;
        if (!readChildren) throw new RouteHydrationReadError();
        const response = await raceRouteAbort(
          () =>
            safeReadAsync(() =>
              readChildren(
                { sessionID: parentSessionID, directory },
                { signal: routeController.signal },
              ),
            ),
          routeController.signal,
        );
        if (!isValid()) return [];
        if (!Array.isArray(response?.data)) {
          throw new RouteHydrationReadError();
        }
        return response.data;
      },
    });
    if (!isValid() || discovery.cancelled) return false;
    const statusResult = await statusResultPromise;
    if (!isValid()) return false;

    const messageEvidence = new Map<
      string,
      Promise<RouteMessageEvidence>
    >();
    const readMessages = (sessionID: string): Promise<RouteMessageEvidence> => {
      const cached = messageEvidence.get(sessionID);
      if (cached) return cached;
      const pending = (async (): Promise<RouteMessageEvidence> => {
        if (!isValid()) {
          return { messages: [], fetchFailed: true };
        }
        const readSessionMessages = sessionClient?.messages;
        if (!readSessionMessages) {
          return { messages: [], fetchFailed: true };
        }
        const response = await raceRouteAbort(
          () =>
            safeReadAsync(() =>
              readSessionMessages(
                { sessionID, directory, limit: ROUTE_CHILD_MESSAGE_LIMIT },
                { signal: routeController.signal },
              ),
            ),
          routeController.signal,
        );
        const messages = Array.isArray(response?.data)
          ? response.data.slice(0, ROUTE_CHILD_MESSAGE_LIMIT)
          : [];
        let tokens: ChildTokenState | undefined;
        for (const message of messages) {
          tokens = mergeTokens(
            tokens,
            extractChildDetails({
              type: "message.updated",
              properties: { part: message },
            }).tokens,
          );
        }
        const model = extractLatestAssistantModel(messages);
        return {
          messages,
          ...summarizeSessionMessages(messages),
          fetchFailed: !Array.isArray(response?.data) || !isValid(),
          ...(model ? { model } : {}),
          ...(tokens ? { tokens } : {}),
        };
      })();
      messageEvidence.set(sessionID, pending);
      return pending;
    };

    const prioritizedSessions = discovery.sessions
      .map((session, index) => ({
        session,
        index,
        running:
          deriveSessionChildStatus(statusResult.statuses[session.id]) ===
            "running" ||
          (statusResult.failed &&
            currentState?.children[session.id]?.status === "running"),
        updatedAtMs:
          timestampMillisFromUnknown(
            session.time?.updated ?? session.time?.created,
          ) ?? 0,
      }))
      .sort((left, right) => {
        if (left.running !== right.running) return left.running ? -1 : 1;
        if (left.updatedAtMs !== right.updatedAtMs) {
          return right.updatedAtMs - left.updatedAtMs;
        }
        return left.index - right.index;
      });
    const messageSessionIDs = [
      currentSessionID,
      ...prioritizedSessions.map(({ session }) => session.id),
    ];
    const hydratedMessages = await mapWithBoundedConcurrency(
      messageSessionIDs,
      ROUTE_CHILD_MESSAGE_CONCURRENCY,
      readMessages,
    );
    if (!isValid()) return false;

    const evidenceBySessionID = new Map(
      messageSessionIDs.map((sessionID, index) => [
        sessionID,
        hydratedMessages[index] ?? { messages: [], fetchFailed: true },
      ]),
    );
    const parentTaskEvidence = new Map<
      string,
      ReadonlyMap<string, ParentTaskEvidence>
    >();
    for (const sessionID of messageSessionIDs) {
      const evidence = evidenceBySessionID.get(sessionID);
      parentTaskEvidence.set(
        sessionID,
        collectParentTaskEvidenceByChildSessionID(
          evidence?.messages ?? [],
          sessionID,
        ),
      );
    }

    let stateToPersist: StatuslineState | undefined;
    let changedChildIDsToPersist: readonly string[] | undefined;
    snapshotSidebarScrollOffsets();
    setState((current) => {
      if (!isValid()) return current;
      const next = cloneState(current);
      const lookup = createChildLookup(next);
      const changedChildIDs = new Set<string>();
      let changed = false;
      const applyEvent = (event: unknown): void => {
        const transaction = applySubagentEventDetailed(next, event, lookup);
        changed = transaction.changed || changed;
        for (const childID of transaction.changedChildIDs) {
          changedChildIDs.add(childID);
        }
      };
      const candidateIDs = (sessionID: string): readonly string[] => [
        ...new Set([sessionID, ...(lookup.byTarget.get(sessionID) ?? [])]),
      ];
      const applyCandidateMutation = (
        sessionID: string,
        mutate: (candidates: readonly string[]) => boolean,
      ): boolean => {
        const candidates = candidateIDs(sessionID);
        const before = new Map(
          candidates.map((childID) => [childID, next.children[childID]]),
        );
        if (!mutate(candidates)) return false;
        for (const childID of candidates) {
          if (
            !sameHydrationChild(before.get(childID), next.children[childID])
          ) {
            refreshChildLookup(lookup, next, childID);
            changedChildIDs.add(childID);
          }
        }
        changed = true;
        return true;
      };

      for (const session of discovery.sessions) {
        const sessionStatus = deriveSessionChildStatus(
          statusResult.statuses[session.id],
        );
        const childEvidence = evidenceBySessionID.get(session.id);
        const parentEvidence = parentTaskEvidence
          .get(session.parentID)
          ?.get(session.id);
        const parentEvidenceByChildID =
          parentTaskEvidence.get(session.parentID) ?? new Map();
        const hasHydrationEvidence = shouldHydrateSessionChild({
          childID: session.id,
          sessionStatus,
          childSummary: childEvidence,
          parentTaskEvidenceByChildID: parentEvidenceByChildID,
        });

        if (!hasHydrationEvidence) {
          const existing = next.children[session.id];
          if (
            !statusResult.failed &&
            evidenceBySessionID.get(session.parentID)?.fetchFailed !== true &&
            childEvidence?.fetchFailed === false &&
            existing?.parentID === session.parentID &&
            existing.source === "session" &&
            existing.status === "running"
          ) {
            delete next.children[session.id];
            refreshChildLookup(lookup, next, session.id);
            changedChildIDs.add(session.id);
            changed = true;
          }
          continue;
        }

        applyEvent({
          type: "session.created",
          properties: { sessionID: session.id, info: session },
        });
        if (childEvidence?.model) {
          const modelEvidence = childEvidence.model;
          applyCandidateMutation(session.id, (candidates) =>
            setChildModel(
              next,
              session.id,
              modelEvidence.model,
              modelEvidence.updatedAt,
              candidates,
            ),
          );
        }
        if (
          childEvidence?.tokens &&
          upsertChildDetails(next, session.id, {
            tokens: childEvidence.tokens,
          })
        ) {
          changedChildIDs.add(session.id);
          changed = true;
        }

        const resolvedStatus = resolveSessionStatusWithMessageSummary({
          status: sessionStatus ?? parentEvidence?.status,
          summary: childEvidence,
        });
        const fallbackEndedAt =
          childEvidence?.completedAt ?? childEvidence?.evidenceAt;
        if (
          resolvedStatus.status === "done" ||
          resolvedStatus.status === "error"
        ) {
          const terminalStatus = resolvedStatus.status;
          applyCandidateMutation(session.id, (candidates) =>
            markChildStatus(
              next,
              session.id,
              terminalStatus,
              resolvedStatus.endedAt ??
                parentEvidence?.endedAt ??
                fallbackEndedAt ??
                timestampFromUnknown(
                  session.time?.completed ?? session.time?.updated,
                ),
              candidates,
            ),
          );
          continue;
        }
        if (
          !sessionStatus &&
          !statusResult.failed &&
          childEvidence?.fetchFailed === false &&
          (typeof childEvidence.completedAt === "string" ||
            childEvidence.hasError === true)
        ) {
          const childStatus = childEvidence.hasError ? "error" : "done";
          applyCandidateMutation(session.id, (candidates) =>
            markChildStatus(
              next,
              session.id,
              childStatus,
              fallbackEndedAt,
              candidates,
            ),
          );
        }
      }

      for (const parentSessionID of messageSessionIDs) {
        const messages = evidenceBySessionID.get(parentSessionID)?.messages ?? [];
        for (const rawMessage of messages) {
          const message = asRecord(rawMessage);
          const info = asRecord(message?.info);
          const parts = Array.isArray(message?.parts) ? message.parts : [];
          const parentMessageID = messageIDOf(message);
          const time = asRecord(info?.time);
          const completedAt = timestampFromUnknown(time?.completed);
          for (const rawPart of parts) {
            const part = asRecord(rawPart);
            if (!part) continue;
            const partWithMessageID =
              typeof part.messageID === "string" && part.messageID.length > 0
                ? part
                : parentMessageID
                  ? { ...part, messageID: parentMessageID }
                  : part;
            if (
              part.type !== "subtask" &&
              !(
                part.type === "tool" &&
                (part.tool === "delegate" || part.tool === "task")
              )
            ) {
              continue;
            }
            applyEvent({
              type: "message.part.updated",
              properties: {
                sessionID: parentSessionID,
                info: {
                  id: typeof info?.id === "string" ? info.id : undefined,
                  role:
                    typeof info?.role === "string" ? info.role : undefined,
                  parentID:
                    typeof info?.parentID === "string"
                      ? info.parentID
                      : undefined,
                  time,
                },
                part: partWithMessageID,
              },
            });
            if (
              part.type === "subtask" &&
              info?.role === "assistant" &&
              completedAt
            ) {
              const childID = `subtask:${part.id}`;
              const status = info.error ? "error" : "done";
              if (markChildStatus(next, childID, status, completedAt)) {
                refreshChildLookup(lookup, next, childID);
                changedChildIDs.add(childID);
                changed = true;
              }
            }
          }
        }
      }

      const hydratedParentIDs = new Set(messageSessionIDs);
      let targetChanged = false;
      for (const child of Object.values(next.children)) {
        if (!hydratedParentIDs.has(child.parentID)) continue;
        if (resolveChildTargetSessionID(child)) continue;
        const targetSessionID =
          child.source === "session" || child.id.startsWith("ses_")
            ? child.id
            : resolveSyntheticTargetFromHydratedState(next, child, lookup);
        if (
          targetSessionID &&
          setChildTarget(next, child.id, targetSessionID, lookup)
        ) {
          changedChildIDs.add(child.id);
          targetChanged = true;
          changed = true;
        }
      }
      if (targetChanged) next.updatedAt = new Date().toISOString();

      if (hydrationBaseline) {
        preserveFreshHydrationEvidence(next, current, hydrationBaseline);
      }
      const refreshed = refreshLiveState(next);
      const actuallyChangedChildIDs = changedHydrationChildIDs(current, next);
      if (!changed && !refreshed && actuallyChangedChildIDs.length === 0) {
        return current;
      }
      stateToPersist = next;
      changedChildIDsToPersist = refreshed
        ? undefined
        : actuallyChangedChildIDs;
      return next;
    });
    if (!isValid()) return false;
    if (stateToPersist) {
      await persistStateSnapshot(
        persistence,
        stateToPersist,
        true,
        changedChildIDsToPersist,
      ).catch(() => undefined);
    }
    return !(
      discovery.hadFailure ||
      statusResult.failed ||
      hydratedMessages.some(({ fetchFailed }) => fetchFailed)
    );
  } catch (error) {
    debugLog({
      kind: "hydration.error",
      sessionID: currentSessionID,
      error: String(error),
    });
    return false;
  } finally {
    options.signal?.removeEventListener("abort", abortRoute);
  }
}

function shouldHydrateSessionChild(input: {
  childID: string;
  sessionStatus?: ChildSessionState["status"];
  childSummary?: SessionMessageSummary;
  parentTaskEvidenceByChildID: ReadonlyMap<string, ParentTaskEvidence>;
}): boolean {
  if (input.sessionStatus) return true;
  if (input.parentTaskEvidenceByChildID.has(input.childID)) return true;

  const summary = input.childSummary;
  if (!summary || summary.fetchFailed) return false;

  return (
    summary.hasError === true ||
    typeof summary.completedAt === "string" ||
    typeof summary.evidenceAt === "string" ||
    typeof summary.latestAssistantActivityAt === "string" ||
    typeof summary.latestMessageActivityAt === "string"
  );
}

type ParentTaskEvidence = {
  status: ChildSessionState["status"];
  endedAt?: string;
};

function collectParentTaskEvidenceByChildSessionID(
  messages: readonly unknown[],
  parentSessionID: string,
): Map<string, ParentTaskEvidence> {
  const evidenceByID = new Map<string, ParentTaskEvidence>();
  for (const rawMessage of messages) {
    const message = asRecord(rawMessage);
    const info = asRecord(message?.info);
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part || part.type !== "tool" || part.tool !== "task") continue;
      const state = asRecord(part.state);
      const metadata = asRecord(state?.metadata);
      const childID =
        typeof metadata?.sessionId === "string"
          ? metadata.sessionId
          : undefined;
      if (!childID || childID === parentSessionID) continue;

      const taskEvidence = extractTaskToolEvidence({
        type: "message.part.updated",
        properties: {
          sessionID: parentSessionID,
          info: {
            time: info?.time,
          },
          part: rawPart,
        },
      });
      evidenceByID.set(childID, {
        status: taskEvidence?.status ?? "running",
        endedAt: taskEvidence?.endedAt,
      });
    }
  }
  return evidenceByID;
}

async function safeReadAsync<Value>(
  read: () => Promise<Value>,
): Promise<Value | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

function deriveSessionChildStatus(
  status: unknown,
): ChildSessionState["status"] | undefined {
  return deriveOpenCodeSessionStatus(status);
}

function sessionTimestamp(
  session: Record<string, unknown>,
  key: string,
): string | undefined {
  const time = asRecord(session.time);
  return timestampFromUnknown(time?.[key]);
}

function timestampFromUnknown(value: unknown): string | undefined {
  const millis = timestampMillisFromUnknown(value);
  return millis === undefined ? undefined : new Date(millis).toISOString();
}

function timestampMillisFromUnknown(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : millis;
  }
  return undefined;
}

function resolveRouteSessionID(api: TuiPluginApi): string | undefined {
  return api.route.current.name === "session" &&
    typeof api.route.current.params?.sessionID === "string"
    ? api.route.current.params.sessionID
    : undefined;
}

function resolveRunningChildAgeMillis(
  child: ChildSessionState,
  nowMs: number,
): {
  startedMs: number;
  updatedMs: number;
} {
  const startedMs = Date.parse(child.startedAt);
  const updatedMs = Date.parse(child.updatedAt);
  return {
    startedMs: Number.isNaN(startedMs) ? 0 : Math.max(0, nowMs - startedMs),
    updatedMs: Number.isNaN(updatedMs) ? 0 : Math.max(0, nowMs - updatedMs),
  };
}

function resolveReconcileTargetSessionID(
  state: StatuslineState,
  child: ChildSessionState,
  lookup = createChildLookup(state),
): string | undefined {
  return (
    resolveChildTargetSessionID(child) ??
    resolveSyntheticTargetFromHydratedState(state, child, lookup)
  );
}

export function prioritizeTokenHydrationCandidates(
  children: readonly ChildSessionState[],
  currentRouteDescendantSessionIDs?: ReadonlySet<string>,
): ChildSessionState[] {
  return [...children].sort((left, right) => {
    const leftCurrent = currentRouteDescendantSessionIDs?.has(
      resolveChildTargetSessionID(left) ?? left.id,
    )
      ? 1
      : 0;
    const rightCurrent = currentRouteDescendantSessionIDs?.has(
      resolveChildTargetSessionID(right) ?? right.id,
    )
      ? 1
      : 0;
    if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
    const leftRunning = left.status === "running" ? 1 : 0;
    const rightRunning = right.status === "running" ? 1 : 0;
    if (leftRunning !== rightRunning) return rightRunning - leftRunning;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

export function selectRunningReconcileCandidates(input: {
  readonly state: StatuslineState;
  readonly currentSessionID?: string;
  readonly currentRouteDescendantSessionIDs?: ReadonlySet<string>;
  readonly hydratingSessionIDs?: ReadonlySet<string>;
  readonly nowMs: number;
  readonly maxCandidates: number;
  readonly lookup?: ChildLookup;
}): RunningReconcileCandidate[] {
  const runningChildren = Object.values(input.state.children).filter(
    (child) =>
      child.status === "running" &&
      !input.hydratingSessionIDs?.has(child.parentID),
  );
  if (runningChildren.length === 0) return [];
  const lookup = input.lookup ?? createChildLookup(input.state);

  const prioritized = visibleSubagentWorkItems(
    runningChildren,
    input.nowMs,
  ).sort(byPriority);
  const currentRouteDescendantSessionIDs = input.currentSessionID
    ? (input.currentRouteDescendantSessionIDs ??
      buildCurrentRouteSubtreeProjection(input.state, input.currentSessionID)
        .subtree.executionIDs)
    : undefined;
  const prioritizedForSession = currentRouteDescendantSessionIDs
    ? prioritized.filter((child) =>
        currentRouteDescendantSessionIDs.has(
          resolveChildTargetSessionID(child) ?? child.id,
        ),
      )
    : prioritized;

  // Single pass to collect very-old IDs AND remember per-child age so we
  // don't pay resolveRunningChildAgeMillis twice per child.
  const veryOldIDs = new Set<string>();
  const ageByID = new Map<string, ReturnType<typeof resolveRunningChildAgeMillis>>();
  for (const child of runningChildren) {
    const age = resolveRunningChildAgeMillis(child, input.nowMs);
    ageByID.set(child.id, age);
    if (
      age.startedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS ||
      age.updatedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS
    ) {
      veryOldIDs.add(child.id);
    }
  }

  // Build the final order inline to avoid spreading + filtering twice.
  const ordered: typeof runningChildren = [];
  const seen = new Set<string>();
  for (const child of prioritizedForSession) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    ordered.push(child);
  }
  for (const child of runningChildren) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    ordered.push(child);
  }

  const selected: RunningReconcileCandidate[] = [];
  for (const child of ordered) {
    const age = ageByID.get(child.id);
    if (!age) continue;
    const targetSessionID = resolveReconcileTargetSessionID(
      input.state,
      child,
      lookup,
    );
    const canProbePersistedSubtask =
      child.source === "subtask" &&
      !targetSessionID &&
      typeof child.parentID === "string" &&
      child.parentID.length > 0 &&
      typeof child.messageID === "string" &&
      child.messageID.length > 0 &&
      (age.startedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS ||
        age.updatedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS);
    if (!targetSessionID && !canProbePersistedSubtask) continue;
    selected.push({
      childID: child.id,
      targetSessionID,
      parentID: child.parentID,
      messageID: child.messageID,
      status: child.status,
      updatedAt: child.updatedAt,
      source: child.source,
      title: child.title,
      summary: child.summary,
      agentName: child.agentName,
      startedMs: age.startedMs,
      updatedMs: age.updatedMs,
    });
    if (selected.length >= input.maxCandidates) break;
  }

  return capCandidates(selected, input.maxCandidates);
}

function currentRunningReconcileVersion(
  current: StatuslineState,
  candidate: Pick<RunningReconcileVersion, "childID">,
): RunningReconcileVersion | undefined {
  const child = current.children[candidate.childID];
  if (!child) return undefined;
  return {
    childID: child.id,
    targetSessionID: resolveReconcileTargetSessionID(current, child),
    parentID: child.parentID,
    messageID: child.messageID,
    status: child.status,
    updatedAt: child.updatedAt,
  };
}

function retainedRunningReconcileKeys(
  current: StatuslineState,
  nowMs: number,
  lookup: ChildLookup = createChildLookup(current),
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const child of Object.values(current.children)) {
    if (child.status !== "running") continue;
    const targetSessionID = resolveReconcileTargetSessionID(
      current,
      child,
      lookup,
    );
    if (targetSessionID) {
      keys.add(targetSessionID);
      continue;
    }
    const age = resolveRunningChildAgeMillis(child, nowMs);
    if (
      child.source === "subtask" &&
      typeof child.parentID === "string" &&
      child.parentID.length > 0 &&
      typeof child.messageID === "string" &&
      child.messageID.length > 0 &&
      (age.startedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS ||
        age.updatedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS)
    ) {
      keys.add(child.id);
    }
  }
  return keys;
}

export async function probeRunningEvidence(input: {
  api: TuiPluginApi;
  targetSessionID: string;
  directory: string;
  candidateAgeMs: number;
  nowMs: number;
}): Promise<RunningReconcileEvidence> {
  let probeFailed = false;

  const directStatus = safeRead(() =>
    input.api.state.session.status(input.targetSessionID),
  );
  if (directStatus === undefined) probeFailed = true;
  const statusFromState = deriveSessionChildStatus(directStatus);
  if (statusFromState === "error") {
    return { status: statusFromState, endedAt: new Date().toISOString() };
  }
  if (statusFromState === "running") {
    return { status: "running", sawRunningEvidence: true };
  }

  const doneFromState = statusFromState === "done";
  let doneFromClient = false;

  const statusResp = await safeReadAsync(() =>
    input.api.client.session.status({ directory: input.directory }),
  );
  if (statusResp === undefined) probeFailed = true;
  const statuses = asRecord(statusResp?.data);
  const statusFromClient = deriveSessionChildStatus(
    statuses?.[input.targetSessionID],
  );
  if (statusFromClient === "error") {
    return { status: statusFromClient, endedAt: new Date().toISOString() };
  }
  if (statusFromClient === "running") {
    return { status: "running", sawRunningEvidence: true };
  }
  doneFromClient = statusFromClient === "done";

  const hasDoneStatus = doneFromState || doneFromClient;

  if (
    !hasDoneStatus &&
    input.candidateAgeMs < RUNNING_RECONCILE_MESSAGE_AGE_GATE_MS
  ) {
    return { probeFailed, canApplyStaleFallback: false };
  }

  const messagesResp = await safeReadAsync(() =>
    input.api.client.session.messages({
      sessionID: input.targetSessionID,
      directory: input.directory,
    }),
  );
  if (messagesResp === undefined || !Array.isArray(messagesResp?.data)) {
    if (hasDoneStatus) {
      return {
        status: "done",
        endedAt: new Date().toISOString(),
        checkedMessages: false,
        probeFailed: true,
        canApplyStaleFallback: false,
      };
    }
    return {
      checkedMessages: false,
      probeFailed: true,
      canApplyStaleFallback: false,
    };
  }
  const messages = Array.isArray(messagesResp?.data) ? messagesResp.data : [];
  const summary = summarizeSessionMessages(messages);
  const resolvedStatus = resolveSessionStatusWithMessageSummary({
    status: hasDoneStatus ? "done" : undefined,
    summary,
  });

  if (resolvedStatus.status === "error") {
    return {
      status: "error",
      endedAt: resolvedStatus.endedAt,
      checkedMessages: true,
      canApplyStaleFallback: false,
    };
  }

  if (resolvedStatus.status === "done") {
    return {
      status: "done",
      endedAt: resolvedStatus.endedAt ?? new Date().toISOString(),
      checkedMessages: true,
      canApplyStaleFallback: false,
    };
  }

  if (
    hasRecentMessageActivity({
      nowMs: input.nowMs,
      latestMessageActivityAtMs: summary.latestMessageActivityAtMs,
      staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
    })
  ) {
    return {
      checkedMessages: true,
      sawRunningEvidence: true,
      endedAt: summary.latestMessageActivityAt,
      probeFailed,
      canApplyStaleFallback: false,
    };
  }

  return {
    checkedMessages: true,
    probeFailed,
    canApplyStaleFallback: !probeFailed,
  };
}

function initializeTui(api: TuiPluginApi, disposeRoot: () => void): void {
  __setSubagentDebugSink(debugLog);
  // Best-effort cleanup of stale `pid-*` instance directories; never blocks
  // boot on failure and never throws.
  void gcStaleInstanceDirs()
    .then((removed) => {
      debugLog({ kind: "tui.gc.stale-instance-dirs", removed });
    })
    .catch(() => undefined);
  const statePath = resolveStatePath();
  const textPath = resolveTextPath(statePath);
  let lastStatusText = "";
  const persistence = createPersistenceCoordinator<TuiPersistenceSnapshot>(
    async ({ state, changedChildIDs }) => {
      const prepared = await saveState(statePath, state, {
        ...(changedChildIDs !== undefined ? { changedChildIDs } : {}),
      });
      const nextText = renderStatusLine(prepared);
      // Skip status.txt write when the rendered summary is unchanged — the
      // aggregate text only changes on status/visibility transitions, which
      // are rare relative to detail-only event bursts.
      if (nextText !== lastStatusText) {
        await saveStatusText(textPath, nextText);
        lastStatusText = nextText;
      }
    },
    {
      settleDelayMs: 150,
      combineSnapshots: combineTuiPersistenceSnapshots,
    },
  );
  const [state, setState] = createSignal<StatuslineState>(createEmptyState());
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [hydratedSessions, setHydratedSessions] = createSignal<Set<string>>(
    new Set(),
  );
  const [hydratingSessions, setHydratingSessions] = createSignal<Set<string>>(
    new Set(),
  );
  const [hydrateRetryPendingSessions, setHydrateRetryPendingSessions] =
    createSignal<Set<string>>(new Set());
  const [hydrateRetryAttempts, setHydrateRetryAttempts] = createSignal<
    Map<string, number>
  >(new Map());
  const [hydrateRetryTick, setHydrateRetryTick] = createSignal(0);
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(
    api.kv.get<boolean>(SUBAGENTS_EXPANDED_KV_KEY, true) !== false,
  );
  const [subagentsSectionEnabled, setSubagentsSectionEnabled] = createSignal(
    api.kv.get<boolean>(SUBAGENTS_SECTION_ENABLED_KV_KEY, true) !== false,
  );
  const hydrateRetryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const runningReconcileBackoff = new Map<string, RunningReconcileCacheEntry>();
  let reconcileInFlight = false;
  let lastRunningReconcileAtMs = 0;
  let disposed = false;
  let routeGeneration = 0;
  let routeAbortController = new AbortController();
  let routeHydrationSignal = AbortSignal.any([
    api.lifecycle.signal,
    routeAbortController.signal,
  ]);
  let previousRouteSessionID: string | undefined;
  const currentRouteSubtreeCoordinator =
    createCurrentRouteSubtreeCoordinator();
  const currentRouteProjection = createMemo(() => {
    const currentState = state();
    void api.route.current;
    return currentRouteSubtreeCoordinator.read({
      state: currentState,
      sessionID: resolveRouteSessionID(api),
    });
  });
  let pendingSidebarRefocus: PendingSidebarRefocus | undefined;
  let pendingRefocusConsumed = false;
  let activePromptRef: TuiPromptRef | undefined;
  const deferredUiCallbacks = createManagedDeferredCallbacks(
    () => !disposed && !api.lifecycle.signal.aborted,
  );
  const isTokenJobValid = (job: TokenHydrationJob): boolean =>
    !disposed &&
    !api.lifecycle.signal.aborted &&
    job.signal?.aborted !== true &&
    job.generation === routeGeneration &&
    state().children[job.childID] !== undefined;
  const tokenHydrationQueue = createTokenHydrationQueue({
    isValid: isTokenJobValid,
    onError: (error, job) => {
      debugLog({
        kind: "state.tokens.hydration.error",
        childID: job.childID,
        error: error.message,
      });
    },
    hydrate: async (job) => {
      const current = state().children[job.childID];
      if (!current || !isTokenJobValid(job)) return undefined;
      if (current.status !== "running" && hasTokenTotal(current.tokens)) {
        return undefined;
      }
      return hydrateChildTokensAsync(api, current, job.signal);
    },
    commit: (job, hydrated) => {
      if (!isTokenJobValid(job)) return;
      let stateToPersist: StatuslineState | undefined;
      setState((current) => {
        if (!isTokenJobValid(job)) return current;
        const child = current.children[job.childID];
        if (!child) return current;
        const tokens = mergeFreshHydratedTokens(
          child.tokens,
          job.baseline,
          hydrated,
        );
        if (sameTokens(child.tokens, tokens)) return current;
        const next = cloneState(current);
        const nextChild = next.children[job.childID];
        if (!nextChild) return current;
        nextChild.tokens = tokens;
        nextChild.updatedAt = new Date().toISOString();
        next.updatedAt = nextChild.updatedAt;
        refreshLiveState(next);
        stateToPersist = next;
        return next;
      });
      if (stateToPersist && isTokenJobValid(job)) {
        void persistStateSnapshot(persistence, stateToPersist, false, [
          job.childID,
        ]).catch(() => undefined);
      }
    },
  });

  const enqueueTokenHydrationCandidates = (
    childIDs?: readonly string[],
  ): void => {
    if (disposed || api.lifecycle.signal.aborted) return;
    const current = state();
    const currentRouteDescendantSessionIDs =
      currentRouteProjection()?.subtree.executionIDs;
    const ids = childIDs ?? Object.keys(current.children);
    const candidates = prioritizeTokenHydrationCandidates(
      [...new Set(ids)]
        .map((childID) => current.children[childID])
        .filter((child): child is ChildSessionState => child !== undefined)
        .filter(
          (child) => child.status === "running" || !hasTokenTotal(child.tokens),
        ),
      currentRouteDescendantSessionIDs,
    );

    for (const child of candidates) {
      const updatedAtMs = Date.parse(child.updatedAt);
      tokenHydrationQueue.enqueue({
        childID: child.id,
        baseline: child.tokens ? { ...child.tokens } : undefined,
        generation: routeGeneration,
        signal: routeHydrationSignal,
        priority:
          (currentRouteDescendantSessionIDs?.has(
            resolveChildTargetSessionID(child) ?? child.id,
          )
            ? 2_000_000_000_000_000
            : 0) +
          (child.status === "running" ? 1_000_000_000_000_000 : 0) +
          (Number.isFinite(updatedAtMs) ? updatedAtMs : 0),
      });
    }
  };

  const consumePendingSidebarRefocus = ():
    | PendingSidebarRefocus
    | undefined => {
    if (pendingRefocusConsumed) return undefined;
    pendingRefocusConsumed = true;
    return pendingSidebarRefocus;
  };

  const setActivePromptRef = (ref: TuiPromptRef | undefined): void => {
    activePromptRef = ref;
  };

  const composePromptRef = (slotRef: PromptRefProp) => {
    return (ref: TuiPromptRef | undefined): void => {
      setActivePromptRef(ref);
      if (typeof slotRef === "function") {
        slotRef(ref);
      } else if (slotRef && "current" in slotRef) {
        slotRef.current = ref;
      }
    };
  };

  const focusActivePrompt = (): void => {
    focusPromptWithDeferredRetry(() => {
      if (!activePromptRef) return false;
      activePromptRef.focus();
      return true;
    }, deferredUiCallbacks.schedule);
  };

  const rememberSidebarChildNavigation = (
    input: PendingSidebarRefocus,
  ): void => {
    pendingSidebarRefocus = input;
  };

  const setSubagentsExpandedPreference = (expanded: boolean): void => {
    setSubagentsExpanded(expanded);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, expanded);
    api.ui.toast({
      variant: "info",
      message: expanded ? "Subagent list expanded" : "Subagent list collapsed",
    });
  };

  const setSubagentsExpandedSilently = (expanded: boolean): void => {
    setSubagentsExpanded(expanded);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, expanded);
  };

  const setSubagentsSectionEnabledPreference = (enabled: boolean): void => {
    setSubagentsSectionEnabled(enabled);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, enabled);
    api.ui.toast({
      variant: "info",
      message: enabled
        ? "Subagent section enabled"
        : "Subagent section disabled",
    });
  };

  const toggleSidebarListFocus = (): void => {
    api.ui.dialog.clear();
    if (isAnySidebarSubagentListFocused()) {
      blurVisibleSidebarSubagentList();
      focusActivePrompt();
      return;
    }

    setSubagentsSectionEnabled(true);
    setSubagentsExpanded(true);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, true);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, true);
    deferredUiCallbacks.schedule(() => {
      focusVisibleSidebarSubagentList();
    });
  };

  const toggleSidebarCompletedHistory = (): void => {
    api.ui.dialog.clear();
    setSubagentsSectionEnabled(true);
    setSubagentsExpanded(true);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, true);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, true);
    deferredUiCallbacks.schedule(() => {
      toggleVisibleSidebarCompletedHistory();
    });
  };

  const commandDispose = registerSubagentCommands({
    api,
    sectionEnabled: subagentsSectionEnabled,
    toggleSection: setSubagentsSectionEnabledPreference,
    focusSidebarList: toggleSidebarListFocus,
    toggleCompletedHistory: toggleSidebarCompletedHistory,
  });

  const clearHydrateRetryTimeout = (sessionID: string): void => {
    const timeout = hydrateRetryTimeouts.get(sessionID);
    if (timeout) {
      clearTimeout(timeout);
      hydrateRetryTimeouts.delete(sessionID);
    }
  };

  const resetHydrateRetry = (sessionID: string | undefined): void => {
    if (!sessionID) return;
    clearHydrateRetryTimeout(sessionID);
    setHydrateRetryPendingSessions((prev) => {
      if (!prev.has(sessionID)) return prev;
      const next = new Set(prev);
      next.delete(sessionID);
      return next;
    });
    setHydrateRetryAttempts((prev) => {
      if (!prev.has(sessionID)) return prev;
      const next = new Map(prev);
      next.delete(sessionID);
      return next;
    });
  };

  createEffect(() => {
    hydrateRetryTick();
    void api.route.current;
    const routeSessionID = resolveRouteSessionID(api);

    if (previousRouteSessionID !== routeSessionID) {
      routeAbortController.abort();
      routeAbortController = new AbortController();
      routeHydrationSignal = AbortSignal.any([
        api.lifecycle.signal,
        routeAbortController.signal,
      ]);
      routeGeneration += 1;
      if (previousRouteSessionID) resetHydrateRetry(previousRouteSessionID);
    }

    const siblingRefocus = resolveSiblingSidebarRefocus({
      pendingSidebarRefocus,
      routeSessionID,
      children: state().children,
    });
    if (siblingRefocus && pendingSidebarRefocus) {
      pendingSidebarRefocus = {
        ...pendingSidebarRefocus,
        ...siblingRefocus,
      };
    }

    const sidebarReturnAction = resolveSidebarReturnFocusAction({
      pendingSidebarRefocus,
      previousRouteSessionID,
      routeSessionID,
    });
    pendingRefocusConsumed = false;
    if (sidebarReturnAction === "focus-prompt") {
      blurVisibleSidebarSubagentList();
      focusActivePrompt();
    } else if (sidebarReturnAction === "clear-pending") {
      pendingSidebarRefocus = undefined;
    }

    previousRouteSessionID = routeSessionID;

    if (!routeSessionID) return;

    const sessionID = routeSessionID;
    if (
      hydratedSessions().has(sessionID) ||
      hydratingSessions().has(sessionID) ||
      hydrateRetryPendingSessions().has(sessionID) ||
      (hydrateRetryAttempts().get(sessionID) ?? 0) >=
        HYDRATE_RETRY_MAX_ATTEMPTS
    ) {
      return;
    }

    setHydratingSessions((prev) => {
      const next = new Set(prev);
      next.add(sessionID);
      return next;
    });

    const generation = routeGeneration;
    const generationSignal = routeHydrationSignal;
    const isCurrentHydration = (): boolean =>
      !disposed &&
      !generationSignal.aborted &&
      generation === routeGeneration &&
      resolveRouteSessionID(api) === sessionID;

    void (async () => {
      const finishHydrating = (): void => {
        setHydratingSessions((prev) => {
          const next = new Set(prev);
          next.delete(sessionID);
          return next;
        });
      };

      const hydrated = await hydratePreviousSubagents({
        api,
        currentSessionID: sessionID,
        statePath,
        textPath,
        setState,
        persistenceCoordinator: persistence,
        options: {
          signal: generationSignal,
          isValid: isCurrentHydration,
          getCurrentState: state,
        },
      });
      if (!isCurrentHydration()) {
        clearHydrateRetryTimeout(sessionID);
        if (!disposed && !api.lifecycle.signal.aborted) finishHydrating();
        return;
      }
      if (hydrated) {
        resetHydrateRetry(sessionID);
        setHydratedSessions((prev) => {
          const next = new Set(prev);
          next.add(sessionID);
          return next;
        });
        enqueueTokenHydrationCandidates();
        finishHydrating();
        return;
      }

      const attempts = hydrateRetryAttempts().get(sessionID) ?? 0;
      let delayMs: number | undefined;
      const nextAttempts = scheduleHydrateRetry({
        attempts,
        schedule: (delay) => {
          delayMs = delay;
        },
      });

      setHydrateRetryAttempts((prev) => {
        const next = new Map(prev);
        next.set(sessionID, nextAttempts);
        return next;
      });

      if (delayMs === undefined) {
        clearHydrateRetryTimeout(sessionID);
        setHydrateRetryPendingSessions((prev) => {
          if (!prev.has(sessionID)) return prev;
          const next = new Set(prev);
          next.delete(sessionID);
          return next;
        });
        finishHydrating();
        return;
      }

      setHydrateRetryPendingSessions((prev) => {
        const next = new Set(prev);
        next.add(sessionID);
        return next;
      });
      finishHydrating();

      clearHydrateRetryTimeout(sessionID);
      const timeout = setTimeout(() => {
        hydrateRetryTimeouts.delete(sessionID);
        setHydrateRetryPendingSessions((prev) => {
          if (!prev.has(sessionID)) return prev;
          const next = new Set(prev);
          next.delete(sessionID);
          return next;
        });
        if (disposed) return;
        setHydrateRetryTick((value) => value + 1);
      }, delayMs);
      hydrateRetryTimeouts.set(sessionID, timeout);
    })();
  });

  const reconcileRunningChildren = async (): Promise<void> => {
    if (reconcileInFlight || disposed) return;
    reconcileInFlight = true;
    lastRunningReconcileAtMs = Date.now();
    const generation = routeGeneration;
    const isReconcileValid = (): boolean =>
      !disposed &&
      !api.lifecycle.signal.aborted &&
      generation === routeGeneration;

    try {
      const snapshot = state();
      const nowMs = Date.now();
      const currentSessionID = resolveRouteSessionID(api);
      const directory = api.state.path.directory;
      const reconcileLookup = createChildLookup(snapshot);
      sweepRunningReconcileBackoff(
        runningReconcileBackoff,
        retainedRunningReconcileKeys(snapshot, nowMs, reconcileLookup),
      );

      const selected = selectRunningReconcileCandidates({
        state: snapshot,
        currentSessionID,
        currentRouteDescendantSessionIDs:
          currentRouteProjection()?.subtree.executionIDs,
        hydratingSessionIDs: hydratingSessions(),
        nowMs,
        maxCandidates: RUNNING_RECONCILE_MAX_CANDIDATES,
        lookup: reconcileLookup,
      });

      const mutations: Array<{
        version: RunningReconcileVersion;
        childID: string;
        targetSessionID: string;
        status: "done" | "error";
        endedAt?: string;
        reconcileWithoutTargetSessionID?: boolean;
      }> = [];

      const parentMessagesCache = new Map<string, unknown[] | null>();
      const isCandidateCurrent = (
        candidate: RunningReconcileCandidate,
      ): boolean => {
        const currentVersion = currentRunningReconcileVersion(
          state(),
          candidate,
        );
        return (
          isReconcileValid() &&
          matchesRunningReconcileVersion(candidate, currentVersion)
        );
      };

      for (const candidate of selected) {
        if (!isCandidateCurrent(candidate)) continue;
        const key = candidate.targetSessionID ?? candidate.childID;
        const cache = runningReconcileBackoff.get(key);
        if (shouldSkipCandidateForBackoff(cache, nowMs)) continue;

        if (!candidate.targetSessionID) {
          const isPersistedSubtaskCandidate =
            candidate.source === "subtask" &&
            typeof candidate.parentID === "string" &&
            candidate.parentID.length > 0 &&
            typeof candidate.messageID === "string" &&
            candidate.messageID.length > 0;
          if (!isPersistedSubtaskCandidate) continue;

          const parentSessionID = candidate.parentID as string;
          let parentMessages = parentMessagesCache.get(parentSessionID);
          if (parentMessages === undefined) {
            const parentMessagesResp = await safeReadAsync(() =>
              api.client.session.messages({
                sessionID: parentSessionID,
                directory,
              }),
            );
            parentMessages = Array.isArray(parentMessagesResp?.data)
              ? parentMessagesResp.data
              : null;
            parentMessagesCache.set(parentSessionID, parentMessages);
          }
          if (!isCandidateCurrent(candidate)) continue;
          if (parentMessages === null) {
            runningReconcileBackoff.set(
              key,
              nextBackoffState({
                cache,
                nowMs,
                initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
                maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS,
              }),
            );
            continue;
          }

          const evidence = resolvePersistedStaleSubtaskFromParentMessages({
            candidate: {
              childID: candidate.childID,
              parentID: candidate.parentID as string,
              messageID: candidate.messageID as string,
              title: candidate.title,
              summary: candidate.summary,
              agentName: candidate.agentName,
            } satisfies PersistedStaleSubtaskCandidate,
            messages: parentMessages,
          });
          if (!evidence) {
            const parentSummary = summarizeSessionMessages(parentMessages);
            const canSafelyFallbackByParentInactivity =
              canSafelyCloseNoTargetPersistedCandidate({
                nowMs,
                staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
                startedMs: candidate.startedMs,
                updatedMs: candidate.updatedMs,
                latestMessageActivityAtMs:
                  parentSummary.latestMessageActivityAtMs,
              });
            if (canSafelyFallbackByParentInactivity) {
              mutations.push({
                version: candidate,
                childID: candidate.childID,
                targetSessionID: candidate.childID,
                status: "done",
                endedAt:
                  parentSummary.latestMessageActivityAt ??
                  new Date(nowMs - candidate.updatedMs).toISOString(),
                reconcileWithoutTargetSessionID: true,
              });
              runningReconcileBackoff.delete(key);
              continue;
            }
            runningReconcileBackoff.set(
              key,
              nextBackoffState({
                cache,
                nowMs,
                initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
                maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS,
              }),
            );
            continue;
          }

          mutations.push({
            version: candidate,
            childID: candidate.childID,
            targetSessionID: evidence.targetSessionID ?? candidate.childID,
            status: evidence.status,
            endedAt: evidence.endedAt,
            reconcileWithoutTargetSessionID: true,
          });
          runningReconcileBackoff.delete(key);
          continue;
        }

        const targetSessionID = candidate.targetSessionID;
        const evidence = await awaitCurrentRunningReconcileResult({
          version: candidate,
          probe: () =>
            probeRunningEvidence({
              api,
              targetSessionID,
              directory,
              candidateAgeMs: Math.max(
                candidate.startedMs,
                candidate.updatedMs,
              ),
              nowMs,
            }),
          isLifecycleValid: isReconcileValid,
          currentVersion: () =>
            currentRunningReconcileVersion(state(), candidate),
        });
        if (!evidence) continue;

        if (evidence.status === "done" || evidence.status === "error") {
          mutations.push({
            version: candidate,
            childID: candidate.childID,
            targetSessionID,
            status: evidence.status,
            endedAt: evidence.endedAt,
          });
          runningReconcileBackoff.delete(key);
          continue;
        }

        if (evidence.sawRunningEvidence) {
          runningReconcileBackoff.set(key, {
            backoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
            nextAllowedAtMs: nowMs + RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
          });
          continue;
        }

        const shouldApplyFallback = shouldApplyStaleRunningFallback({
          staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
          evidence,
          startedMs: candidate.startedMs,
          updatedMs: candidate.updatedMs,
        });

        if (shouldApplyFallback) {
          mutations.push({
            version: candidate,
            childID: candidate.childID,
            targetSessionID,
            status: "done",
            endedAt: new Date(nowMs - candidate.updatedMs).toISOString(),
          });
          runningReconcileBackoff.delete(key);
          continue;
        }

        runningReconcileBackoff.set(
          key,
          nextBackoffState({
            cache,
            nowMs,
            initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
            maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS,
          }),
        );
      }

      if (mutations.length === 0 || !isReconcileValid()) return;

      snapshotSidebarScrollOffsets();
      let stateToPersist: StatuslineState | undefined;
      setState((current: StatuslineState) => {
        if (!isReconcileValid()) return current;
        const currentMutations = mutations.filter((mutation) => {
          return matchesRunningReconcileVersion(
            mutation.version,
            currentRunningReconcileVersion(current, mutation.version),
          );
        });
        if (currentMutations.length === 0) return current;
        const next = cloneState(current);
        let changed = false;

        for (const mutation of currentMutations) {
          if (
            mutation.reconcileWithoutTargetSessionID &&
            mutation.targetSessionID.startsWith("ses_")
          ) {
            changed =
              upsertChildDetails(next, mutation.childID, {
                targetSessionID: mutation.targetSessionID,
                updatedAt: mutation.endedAt,
              }) || changed;
          }
          if (
            markChildStatus(
              next,
              mutation.reconcileWithoutTargetSessionID
                ? mutation.childID
                : mutation.targetSessionID,
              mutation.status,
              mutation.endedAt,
            )
          ) {
            changed = true;
          }
        }

        const refreshed = refreshLiveState(next);
        if (!changed && !refreshed) return current;
        stateToPersist = next;
        return next;
      });
      const terminalFlush = stateToPersist
        ? isReconcileValid()
          ? persistStateSnapshot(persistence, stateToPersist, true)
          : undefined
        : undefined;
      await terminalFlush?.catch(() => undefined);
    } finally {
      reconcileInFlight = false;
    }
  };

  const timers = createTuiMaintenanceTimers({
    onElapsedTick: () => {
      snapshotSidebarScrollOffsets();
      setNowMs(Date.now());
    },
    onMaintenanceTick: () => {
      const currentNowMs = Date.now();
      const demand = resolveTuiMaintenanceDemand({
        state: state(),
        nowMs: currentNowMs,
        lastRunningReconcileAtMs,
        hydratingSessionIDs: hydratingSessions(),
      });
      if (demand.reconcile) {
        void reconcileRunningChildren();
      }

      if (demand.prune) {
        setState((current: StatuslineState) => {
          const next = runTuiStateMaintenance(api, current);
          if (next === current) return current;
          snapshotSidebarScrollOffsets();
          void persistStateSnapshot(persistence, next).catch(() => undefined);
          return next;
        });
      }
      if (demand.hydrateTokens) enqueueTokenHydrationCandidates();
    },
  });

  createEffect(() => {
    timers.syncElapsedTimer(
      Object.values(state().children).some((child) => child.status === "running"),
    );
  });

  const eventOwnershipGate = createTuiEventOwnershipGate();
  const applyEvent = async (event: unknown): Promise<void> => {
    const routeSessionID = resolveRouteSessionID(api);
    if (
      !eventOwnershipGate.accepts(event, {
        currentDirectory: api.state.path.directory,
        ...(routeSessionID ? { routeSessionID } : {}),
        children: state().children,
        getSessionDirectory: (sessionID) =>
          api.state.session.get(sessionID)?.directory,
      })
    ) {
      return;
    }
    debugEvent(event);
    snapshotSidebarScrollOffsets();
    let stateToPersist: StatuslineState | undefined;
    let terminalTransition = false;
    let changedChildIDs: readonly string[] = [];
    setState((current: StatuslineState) => {
      const next = cloneState(current);
      const transaction = applySubagentEventDetailed(next, event);
      const changed = transaction.changed;
      changedChildIDs = transaction.changedChildIDs;
      if (changed) {
        debugLog({
          kind: "state.changed",
          children: Object.values(next.children).map((child) => ({
            id: child.id,
            parentID: child.parentID,
            title: child.title,
            status: child.status,
            source: child.source,
          })),
        });
      }
      const refreshed = refreshLiveState(next);
      if (!changed && !refreshed) return current;
      const terminal =
        transaction.mutationCategories.includes("status") &&
        transaction.changedChildIDs.some((childID) => {
          const child = next.children[childID];
          return child?.status === "done" || child?.status === "error";
        });
      stateToPersist = next;
      terminalTransition = terminal;
      return next;
    });
    if (stateToPersist) {
      const completion = persistStateSnapshot(
        persistence,
        stateToPersist,
        terminalTransition,
        changedChildIDs,
      );
      if (terminalTransition) await completion.catch(() => undefined);
      else void completion.catch(() => undefined);
    }
    enqueueTokenHydrationCandidates(changedChildIDs);
  };

  const disposers = [
    api.event.on("session.created", applyEvent),
    api.event.on("session.updated", applyEvent),
    api.event.on("session.status", applyEvent),
    api.event.on("session.idle", applyEvent),
    api.event.on("session.error", applyEvent),
    api.event.on("message.updated", applyEvent),
    api.event.on("message.part.updated", applyEvent),
  ];

  const disposeTui = createBestEffortDisposer(
    [
      () => {
        disposed = true;
        routeGeneration += 1;
        routeAbortController.abort();
        activePromptRef = undefined;
        __setSubagentDebugSink(undefined);
      },
      timers.dispose,
      deferredUiCallbacks.dispose,
      () => {
        for (const timeout of hydrateRetryTimeouts.values()) {
          clearTimeout(timeout);
        }
        hydrateRetryTimeouts.clear();
      },
      tokenHydrationQueue.dispose,
      () => {
        runningReconcileBackoff.clear();
      },
      commandDispose,
      ...disposers,
      persistence.close,
      disposeRoot,
    ],
    (error) => {
      debugLog({
        kind: "lifecycle.cleanup.error",
        error: error.message,
      });
    },
  );
  api.lifecycle.onDispose(disposeTui);

  api.slots.register({
    order: 90,
    slots: {
      sidebar_content(ctx: SidebarContentContext) {
        const routeSessionID = resolveRouteSessionID(api);
        const sessionID = ctx.session_id ?? routeSessionID ?? "";
        debugLog({
          kind: "slot.sidebar_content",
          ctxSessionID: ctx.session_id,
          resolvedSessionID: sessionID,
          route: api.route.current,
          childCount: Object.keys(state().children).length,
        });
        const restoreFromChild = (() => {
          const pending = consumePendingSidebarRefocus();
          if (pending?.parentSessionID !== sessionID) return undefined;
          return {
            childRowID: pending.childRowID,
            showCompletedHistory: pending.showCompletedHistory ?? false,
          };
        })();
        return (
          <Show when={subagentsSectionEnabled()}>
            <SidebarSubagents
              api={api}
              sessionID={sessionID}
              state={state}
              nowMs={nowMs}
              expanded={subagentsExpanded}
              onToggleExpanded={() =>
                setSubagentsExpandedPreference(!subagentsExpanded())
              }
              onSetExpanded={setSubagentsExpandedSilently}
              onReturnFocus={focusActivePrompt}
              onToggleListFocus={toggleSidebarListFocus}
              onNavigateToChild={rememberSidebarChildNavigation}
              sidebarWidth={() => resolveSidebarWidth(ctx)}
              theme={ctx.theme.current}
              restoreFromChild={restoreFromChild}
              currentRouteProjection={currentRouteProjection}
            />
          </Show>
        );
      },
      home_bottom(ctx: HomeBottomContext) {
        return <HomeBottomStatus state={state} theme={ctx.theme.current} />;
      },
      home_prompt(_ctx: TuiSlotContext, props: HomePromptProps) {
        const promptProps = {
          ...props,
          ...(props.workspaceID === undefined &&
          props.workspace_id !== undefined
            ? { workspaceID: props.workspace_id }
            : {}),
          ref: composePromptRef(props.ref),
        };
        return <api.ui.Prompt {...promptProps} />;
      },
      session_prompt(_ctx: TuiSlotContext, props: SessionPromptProps) {
        const sessionID = props.sessionID ?? props.session_id;
        const promptProps = {
          ...props,
          ...(props.sessionID === undefined && props.session_id !== undefined
            ? { sessionID: props.session_id }
            : {}),
          ...(props.onSubmit === undefined && props.on_submit !== undefined
            ? { onSubmit: props.on_submit }
            : {}),
          right:
            props.right ??
            (sessionID ? (
              <api.ui.Slot name="session_prompt_right" session_id={sessionID} />
            ) : undefined),
          ref: composePromptRef(props.ref),
        };
        return <api.ui.Prompt {...promptProps} />;
      },
    },
  });
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  createRoot((disposeRoot) => initializeTui(api, disposeRoot));
};

/**
 * Exported for tests so they can drive the TUI plugin lifecycle against a
 * fake `TuiPluginApi`. The default plugin export wraps this in `createRoot`.
 */
export { initializeTui as __tuiInitializeForTests, tui as __tuiPluginForTests };

const plugin: TuiPluginModule = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
