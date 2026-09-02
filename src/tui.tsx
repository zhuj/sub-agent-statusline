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
import { appendFileSync, mkdirSync } from "node:fs";
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
  CHANGED_CHILD_IDS,
  markChildStatus,
  isTerminalPruningDue,
  isTerminalPruningDueAt,
  gcStaleInstanceDirs,
  mergeTokens,
  refreshDerivedFields,
  resolveStatePath,
  resolveTextPath,
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
import { buildSubagentProjectionFromChildren, filterVisibleFromCanonical } from "./projection.js";
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
  ROUTE_CHILD_MESSAGE_ADMISSION_LIMIT,
  ROUTE_CHILD_MESSAGE_CONCURRENCY,
  createTokenHydrationQueue,
  mapWithBoundedConcurrency,
  mergeFreshHydratedTokens,
  scheduleHydrateRetry,
  type TokenHydrationJob,
} from "./tui-hydration.js";
import { createTuiEventOwnershipGate } from "./tui-event-ownership.js";
import { t } from "./i18n.js";

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
const SUBAGENTS_ROW_MARKER_WIDTH = 4;
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

function debugLog(input: Record<string, unknown>): void {
  if (!process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS) return;
  try {
    const path = join(
      process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
      "opencode-subagent-statusline",
      "tui-events.log",
    );
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), ...input });
    appendFileSync(path, `${line}\n`, "utf8");
  } catch {
    // Debug logging must never crash the TUI.
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

export function persistStateSnapshot(
  persistence: PersistenceCoordinator<StatuslineState>,
  state: StatuslineState,
  flush = false,
  changedChildIDs?: readonly string[],
): Promise<void> {
  // No deep clone: all callers pass a freshly-produced state object (a `next`
  // that was just built with `cloneState(current)` and then mutated). The
  // writer's `JSON.stringify` consumes the structure into a string before any
  // subsequent state churn could affect it. Skipping the clone saves N object
  // spreads per persistence cycle (significant for the 1,500-child terminal cap).
  //
  // When the caller knows which children changed, attach them as a Symbol
  // property on the snapshot. saveState reads it to do a differential refresh
  // instead of re-deriving every child. JSON.stringify ignores Symbol keys.
  if (changedChildIDs !== undefined) {
    (state as unknown as Record<symbol, unknown>)[CHANGED_CHILD_IDS] =
      changedChildIDs;
  }
  return flush
    ? persistence.flush(state)
    : persistence.request(state);
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
): boolean {
  let changed = false;
  const lookup = createChildLookup(state);

  for (const child of Object.values(state.children)) {
    if (child.parentID !== parentSessionID) continue;
    if (resolveChildTargetSessionID(child)) continue;
    if (child.source === "session" || child.id.startsWith("ses_")) {
      if (setChildTarget(state, child.id, child.id, lookup)) changed = true;
      continue;
    }

    const syntheticTarget = resolveSyntheticTargetFromHydratedState(
      state,
      child,
      lookup,
    );
    if (syntheticTarget) {
      if (setChildTarget(state, child.id, syntheticTarget, lookup)) {
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
  if (!continuation) return parenthetical;
  if (!parenthetical) return continuation;

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

function formatChildRowLine(input: {
  child: ChildSessionState;
  nowMs: number;
  sidebarWidth?: number;
  reservedWidth?: number;
}): {
  labelLines: string[];
  secondaryLine?: string;
  elapsed: string;
  meta: string;
} {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = Math.max(
    MIN_ROW_WIDTH,
    rowWidthBudget(input.sidebarWidth) - (input.reservedWidth ?? 0),
  );
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);

  for (const meta of contextVariants(input.child)) {
    const detailChars =
      2 + textColumns(elapsed) + (meta ? 3 + textColumns(meta) : 0);
    const labelBudget = Math.min(
      width - 2,
      width - Math.max(0, detailChars - width),
    );
    if (labelBudget >= MIN_LABEL_WIDTH || textColumns(meta) === 0) {
      const labelLines = wrapCompactText(
        title.label,
        Math.max(1, labelBudget),
        2,
      );
      return {
        labelLines,
        secondaryLine: formatSecondaryLine(
          labelLines[1],
          parenthetical,
          Math.max(1, labelBudget),
        ),
        elapsed,
        meta,
      };
    }
  }

  const labelLines = wrapCompactText(title.label, MIN_LABEL_WIDTH, 2);
  return {
    labelLines,
    secondaryLine: formatSecondaryLine(
      labelLines[1],
      parenthetical,
      MIN_LABEL_WIDTH,
    ),
    elapsed,
    meta: "",
  };
}

function formatTerminalChildRowLine(input: {
  child: ChildSessionState;
  nowMs: number;
  sidebarWidth?: number;
  reservedWidth?: number;
}): {
  label: string;
  meta: string;
} {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = Math.max(MIN_ROW_WIDTH, rowWidthBudget(input.sidebarWidth));
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);
  const labelSource = parenthetical
    ? `${title.label} ${parenthetical}`
    : title.label;
  const context = contextVariants(input.child).find(
    (variant) => variant.length > 0,
  );

  return {
    label: ellipsize(
      labelSource,
      Math.max(1, width - (input.reservedWidth ?? 0)),
    ),
    meta: context ? `${elapsed} ${context}` : elapsed,
  };
}

export function subagentRowHeight(input: {
  child: ChildSessionState;
  nowMs: number;
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
  visibleChildren: ChildSessionState[];
  visibleCounts: StatusCounts;
  totalExecuted: number;
  showingOtherSessions: boolean;
}

export function resolveTuiSubagentSnapshot(input: {
  state: StatuslineState;
  sessionID?: string;
  nowMs?: number;
  showCompletedHistory?: boolean;
}): TuiSubagentSnapshot {
  const allChildren = Object.values(input.state.children);
  const options = { showCompletedHistory: input.showCompletedHistory };
  const nowMs = input.nowMs ?? Date.now();
  // Preserve old behavior: scope raw children by parent session BEFORE
  // correlation, so proxies from other parents cannot affect scoped results.
  const scopedRawChildren = input.sessionID
    ? allChildren.filter((child) => child.parentID === input.sessionID)
    : allChildren;
  const projection = buildSubagentProjectionFromChildren(scopedRawChildren);
  const scopedCanonical = input.sessionID
    ? projection.canonicalRows.filter(
        (child) => child.parentID === input.sessionID,
      )
    : projection.canonicalRows;
  const ownVisibleChildren = filterVisibleFromCanonical(
    scopedCanonical,
    nowMs,
    options,
  ).sort(byPriority);

  let visibleCounts: StatusCounts;
  let totalExecuted: number;
  if (input.sessionID) {
    const counts: StatusCounts = { running: 0, done: 0, error: 0 };
    const seenExecutionIDs = new Set<string>();
    let counted = 0;
    for (const row of scopedCanonical) {
      if (row.status === "running") counts.running += 1;
      else if (row.status === "done") counts.done += 1;
      else if (row.status === "error") counts.error += 1;
      const executionID = row.targetSessionID ?? row.id;
      if (!seenExecutionIDs.has(executionID)) {
        seenExecutionIDs.add(executionID);
        if (input.state.countedChildIDs[executionID]) counted += 1;
      }
    }
    visibleCounts = counts;
    totalExecuted = counted;
  } else {
    visibleCounts = projection.retainedCounts;
    totalExecuted = projection.totalExecuted;
  }

  return {
    visibleChildren: ownVisibleChildren,
    visibleCounts,
    totalExecuted,
    showingOtherSessions: false,
  };
}

export function resolveSidebarSubagentSnapshot(input: {
  state: StatuslineState;
  sessionID: string;
  nowMs?: number;
  showCompletedHistory?: boolean;
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
}) {
  const [showCompletedHistory, setShowCompletedHistory] = createSignal(
    props.restoreFromChild?.showCompletedHistory ?? false,
  );
  const completedHistoryOptions = () => ({
    showCompletedHistory: showCompletedHistory(),
  });
  const snapshot = createMemo(() =>
    resolveSidebarSubagentSnapshot({
      state: props.state(),
      sessionID: props.sessionID,
      nowMs: props.nowMs(),
      ...completedHistoryOptions(),
    }),
  );
  const visibleChildren = createMemo(() => snapshot().visibleChildren);
  const counts = createMemo(() => snapshot().visibleCounts);
  const totalExecuted = createMemo(() => snapshot().totalExecuted);

  const visibleChildIDs = createMemo(() =>
    visibleChildren().map((child) => child.id),
  );
  const visibleChildByID = createMemo(
    () => new Map(visibleChildren().map((child) => [child.id, child])),
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
    // Cheap structural key — avoids JSON.stringify on every child per render.
    let out = "";
    for (const child of visibleChildren()) {
      const tokens = child.tokens;
      const model = child.model;
      out +=
        `${child.id}\u0001${child.status}\u0001${child.title}` +
        `\u0001${child.summary ?? ""}\u0001${child.agentName ?? ""}` +
        `\u0001${tokens?.input ?? ""}\u0001${tokens?.output ?? ""}` +
        `\u0001${tokens?.total ?? ""}\u0001${tokens?.contextPercent ?? ""}` +
        `\u0001${model?.providerID ?? ""}\u0001${model?.modelID ?? ""}` +
        `\u0001${model?.variant ?? ""}|`;
    }
    return out;
  });

  const rowLayoutIndex = createMemo(() => {
    const nowMs = props.nowMs();
    const sidebarWidth = props.sidebarWidth?.();
    return buildSidebarRowLayoutIndex(
      visibleChildren().map((child) => ({
        id: child.id,
        height: subagentRowHeight({
          child,
          nowMs,
          sidebarWidth,
          reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
        }),
      })),
      SUBAGENTS_ROW_GAP,
    );
  });

  const listHeight = createMemo(() => {
    return Math.max(
      1,
      Math.min(SUBAGENTS_MAX_LIST_HEIGHT, rowLayoutIndex().contentHeight),
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
      scrollbox?.viewport.height ?? listHeight(),
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
      listHeight(),
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
    const viewportBottom = viewportTop + listHeight();

    if (rowTop < viewportTop) {
      const nextTop = clampedScrollTop(scrollbox, rowTop);
      scrollRegistration.offsetTop = nextTop;
      scrollbox.scrollTop = nextTop;
    } else if (rowBottom > viewportBottom) {
      const nextTop = clampedScrollTop(scrollbox, rowBottom - listHeight());
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

  const resolveNavigableChildTargetSessionID = (
    child: ChildSessionState,
  ): string | undefined =>
    resolveChildTargetSessionID(child) ??
    resolveSyntheticTargetFromHydratedState(props.state(), child);

  const selectedTargetSessionID = (): string | undefined => {
    const selectedID = selectedChildID();
    const selected = selectedID
      ? visibleChildByID().get(selectedID)
      : undefined;
    return selected
      ? resolveNavigableChildTargetSessionID(selected)
      : undefined;
  };

  const activateChildTarget = (
    childRowID: string,
    targetSessionID: string,
  ): void => {
    props.onNavigateToChild({
      parentSessionID: props.sessionID,
      childSessionID: targetSessionID,
      childRowID,
      showCompletedHistory: showCompletedHistory(),
    });
    snapshotSidebarScrollOffsets();
    navigateToSessionTarget(props.api, targetSessionID);
  };

  const activateSelectedChild = (): void => {
    activateSidebarSelection({
      selectedRowID: selectedChildID(),
      mountedActivations: rowActivations,
      targetSessionID: selectedTargetSessionID(),
      navigate: (targetSessionID) => {
        const selectedID = selectedChildID();
        if (selectedID && targetSessionID) {
          activateChildTarget(selectedID, targetSessionID);
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
    listHeight();
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
    const child = createMemo(() => visibleChildByID().get(rowProps.childID));
    const [hovered, setHovered] = createSignal(false);
    const [focused, setFocused] = createSignal(false);
    const targetSessionID = createMemo(() => {
      const currentChild = child();
      return currentChild
        ? resolveNavigableChildTargetSessionID(currentChild)
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
    const line = createMemo(() => {
      const currentChild = child();
      if (!currentChild) {
        return { labelLines: [""], elapsed: "00:00", meta: "" };
      }
      return formatChildRowLine({
        child: currentChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
      });
    });
    const terminalLine = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return { label: "", meta: "00:00" };
      return formatTerminalChildRowLine({
        child: currentChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH,
      });
    });
    const rowHeight = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return SUBAGENTS_TERMINAL_ROW_HEIGHT;
      return subagentRowHeight({
        child: currentChild,
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
        rowWidthBudget(props.sidebarWidth?.()) - SUBAGENTS_ROW_MARKER_WIDTH,
      );
    });
    const activate = () => {
      const target = targetSessionID();
      if (target) activateChildTarget(rowProps.childID, target);
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
              >{`    ↳ ${CLOCK_ICON} ${terminalLine().meta}`}</text>
              <Show when={modelLine()}>
                {(metadata: Accessor<string>) => (
                  <text fg={props.theme.textMuted}>{`    ${metadata()}`}</text>
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
                >{`    ${secondaryLine()}`}</text>
              )}
            </Show>
            <box flexDirection="row" paddingLeft={4}>
              <text
                fg={emphasized() ? props.theme.text : props.theme.textMuted}
              >{`↳ ${CLOCK_ICON} ${line().elapsed}`}</text>
              <Show when={line().meta.length > 0}>
                <text
                  fg={emphasized() ? props.theme.text : props.theme.textMuted}
                >{` ${TOKEN_ICON} ${line().meta}`}</text>
              </Show>
            </box>
            <Show when={modelLine()}>
              {(metadata: Accessor<string>) => (
                <text fg={props.theme.textMuted}>{`    ${metadata()}`}</text>
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
          height={listHeight()}
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

export async function hydratePreviousSubagents(
  api: TuiPluginApi,
  currentSessionID: string,
  statePath: string,
  textPath: string,
  setState: (fn: (prev: StatuslineState) => StatuslineState) => void,
  persistenceCoordinator?: PersistenceCoordinator<StatuslineState>,
  options: {
    readonly signal?: AbortSignal;
    readonly isValid?: () => boolean;
    readonly getCurrentState?: () => StatuslineState;
  } = {},
): Promise<boolean> {
  if (!currentSessionID) return false;
  const isValid = (): boolean =>
    options.signal?.aborted !== true && (options.isValid?.() ?? true);
  if (!isValid()) return false;

  try {
    const persistence =
      persistenceCoordinator ??
      createPersistenceCoordinator(async (snapshot) => {
        await saveState(statePath, snapshot);
        await saveStatusText(textPath, renderStatusLine(snapshot));
      });
    const directory = api.state.path.directory;
    let stateToPersist: StatuslineState | undefined;
    const sessionClient = api.client.session;
    let topLevelHydrationFailed = false;
    let statusHydrationFailed = false;
    let parentMessageHydrationFailed = false;

    const [childrenResp, messagesResp, statusResp] = await Promise.all([
      (async () => {
        const response = await safeReadAsync(
          () =>
            sessionClient?.children?.(
              {
                sessionID: currentSessionID,
                directory,
              },
              { signal: options.signal },
            ) ?? Promise.resolve({ data: [] }),
        );
        if (!Array.isArray(response?.data)) topLevelHydrationFailed = true;
        return response;
      })(),
      (async () => {
        const response = await safeReadAsync(
          () =>
            sessionClient?.messages?.(
              {
                sessionID: currentSessionID,
                directory,
              },
              { signal: options.signal },
            ) ?? Promise.resolve({ data: [] }),
        );
        if (!Array.isArray(response?.data)) {
          topLevelHydrationFailed = true;
          parentMessageHydrationFailed = true;
        }
        return response;
      })(),
      (async () => {
        const response = await safeReadAsync(
          () =>
            sessionClient?.status?.(
              { directory },
              { signal: options.signal },
            ) ??
            Promise.resolve({ data: {} }),
        );
        if (!asRecord(response?.data) || Array.isArray(response?.data)) {
          topLevelHydrationFailed = true;
          statusHydrationFailed = true;
        }
        return response;
      })(),
    ]);
    if (!isValid()) return false;

    const children = Array.isArray(childrenResp?.data) ? childrenResp.data : [];
    const messages = Array.isArray(messagesResp?.data) ? messagesResp.data : [];
    const allStatuses = asRecord(statusResp?.data) ?? {};
    const parentTaskEvidenceByChildID =
      collectParentTaskEvidenceByChildSessionID(messages, currentSessionID);
    type ChildMessageResult =
      SessionMessageSummary & {
        childID?: string;
        fetchFailed: boolean;
        model?: ReturnType<typeof extractLatestAssistantModel>;
      };
    const prioritizedChildren = children
      .map((child, index) => {
        const session = asRecord(child);
        const childID =
          typeof session?.id === "string" ? session.id : undefined;
        const status = childID
          ? deriveSessionChildStatus(allStatuses[childID])
          : undefined;
        const persistedRunning = childID
          ? options.getCurrentState?.().children[childID]?.status === "running"
          : false;
        const updatedAt = session
          ? (sessionTimestamp(session, "updated") ??
            sessionTimestamp(session, "created"))
          : undefined;
        return {
          child,
          index,
          running:
            status === "running" ||
            (statusHydrationFailed && persistedRunning),
          updatedAtMs: updatedAt ? Date.parse(updatedAt) : 0,
        };
      })
      .sort((left, right) => {
        if (left.running !== right.running) return left.running ? -1 : 1;
        if (left.updatedAtMs !== right.updatedAtMs) {
          return right.updatedAtMs - left.updatedAtMs;
        }
        return left.index - right.index;
      });
    const admittedChildren = prioritizedChildren.slice(
      0,
      ROUTE_CHILD_MESSAGE_ADMISSION_LIMIT,
    );
    const hydratedChildResults = await mapWithBoundedConcurrency(
      admittedChildren,
      ROUTE_CHILD_MESSAGE_CONCURRENCY,
      async ({ child, index }): Promise<{
        readonly index: number;
        readonly result: ChildMessageResult;
      }> => {
        const session = asRecord(child);
        const childID =
          typeof session?.id === "string" ? session.id : undefined;
        if (!childID || !isValid()) {
          return {
            index,
            result: {
              childID,
              completedAt: undefined,
              evidenceAt: undefined,
              hasError: false,
              fetchFailed: !isValid(),
            },
          };
        }
        const childMessagesResp = await safeReadAsync(
          () =>
            sessionClient?.messages?.(
              {
                sessionID: childID,
                directory,
                limit: 50,
              },
              { signal: options.signal },
            ) ??
            Promise.resolve({ data: [] }),
        );
        const fetchFailed =
          !Array.isArray(childMessagesResp?.data) || !isValid();
        const childMessages = Array.isArray(childMessagesResp?.data)
          ? childMessagesResp.data
          : [];
        return {
          index,
          result: {
            childID,
            ...summarizeSessionMessages(childMessages),
            model: extractLatestAssistantModel(childMessages),
            fetchFailed,
          },
        };
      },
    );
    if (!isValid()) return false;
    const resultsByIndex = new Map(
      hydratedChildResults.map(({ index, result }) => [index, result]),
    );
    const childMessageResults: ChildMessageResult[] = children.map(
      (child, index) => {
        const hydrated = resultsByIndex.get(index);
        if (hydrated) return hydrated;
        const session = asRecord(child);
        return {
          childID:
            typeof session?.id === "string" ? session.id : undefined,
          completedAt: undefined,
          evidenceAt: undefined,
          hasError: false,
          fetchFailed: true,
        };
      },
    );
    const childHydrationFailed = hydratedChildResults.some(
      ({ result }) => result.fetchFailed,
    );
    const childMessageSummaryByID = new Map(
      childMessageResults
        .filter((result) => result.childID)
        .map((result) => [result.childID as string, result]),
    );

    if (!isValid()) return false;
    snapshotSidebarScrollOffsets();
    setState((current) => {
      if (!isValid()) return current;
      const next = cloneState(current);
      let changed = false;

      for (const rawSession of children) {
        const session = asRecord(rawSession);
        if (!session || typeof session.id !== "string") continue;
        const status = allStatuses[session.id];
        const sessionStatus = deriveSessionChildStatus(status);
        const childSummary = childMessageSummaryByID.get(session.id);
        const hasHydrationEvidence = shouldHydrateSessionChild({
          childID: session.id,
          sessionStatus,
          childSummary,
          parentTaskEvidenceByChildID,
        });
        const parentTaskEvidence = parentTaskEvidenceByChildID.get(session.id);
        const explicitCompletionEvidence =
          !!childSummary &&
          !childSummary.fetchFailed &&
          (typeof childSummary.completedAt === "string" ||
            childSummary.hasError);
        const fallbackEndedAt =
          childSummary?.completedAt ?? childSummary?.evidenceAt;
        const statusEndedAt =
          fallbackEndedAt ??
          sessionTimestamp(session, "completed") ??
          sessionTimestamp(session, "updated");
        const shouldHydrateChildFromSession = hasHydrationEvidence;

        if (!shouldHydrateChildFromSession) {
          const existing = next.children[session.id];
          if (
            !statusHydrationFailed &&
            !parentMessageHydrationFailed &&
            !!childSummary &&
            !childSummary.fetchFailed &&
            existing?.parentID === currentSessionID &&
            existing.source === "session" &&
            existing.status === "running"
          ) {
            delete next.children[session.id];
            changed = true;
          }
          continue;
        }

        const fakeEvent = {
          type: "session.created",
          properties: {
            sessionID: session.id,
            info: session,
          },
        };
        if (applySubagentEvent(next, fakeEvent)) changed = true;
        if (childSummary?.model) {
          changed =
            setChildModel(
              next,
              session.id,
              childSummary.model.model,
              childSummary.model.updatedAt,
            ) || changed;
        }

        const resolvedStatus = resolveSessionStatusWithMessageSummary({
          status: sessionStatus ?? parentTaskEvidence?.status,
          summary: childSummary,
        });

        if (
          resolvedStatus.status === "done" ||
          resolvedStatus.status === "error"
        ) {
          if (
            markChildStatus(
              next,
              session.id,
              resolvedStatus.status,
              resolvedStatus.endedAt ??
                parentTaskEvidence?.endedAt ??
                statusEndedAt,
            )
          )
            changed = true;
          continue;
        }

        if (
          !sessionStatus &&
          !statusHydrationFailed &&
          explicitCompletionEvidence
        ) {
          const childStatus = childSummary?.hasError ? "error" : "done";
          if (markChildStatus(next, session.id, childStatus, fallbackEndedAt))
            changed = true;
        }
      }

      for (const rawMessage of messages) {
        const message = asRecord(rawMessage);
        const info = asRecord(message?.info);
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        const parentMessageID = messageIDOf(message);
        const isAssistant = info?.role === "assistant";
        const time = asRecord(info?.time);
        const eventInfo = {
          id: typeof info?.id === "string" ? info.id : undefined,
          role: typeof info?.role === "string" ? info.role : undefined,
          parentID:
            typeof info?.parentID === "string" ? info.parentID : undefined,
          time,
        };
        const completedAt = timestampFromUnknown(time?.completed);
        const isCompleted = typeof completedAt === "string";
        const hasError = !!info?.error;

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
            part.type === "subtask" ||
            (part.type === "tool" &&
              (part.tool === "delegate" || part.tool === "task"))
          ) {
            const fakeEvent = {
              type: "message.part.updated",
              properties: {
                sessionID: currentSessionID,
                info: eventInfo,
                part: partWithMessageID,
              },
            };
            if (applySubagentEvent(next, fakeEvent)) changed = true;

            if (part.type === "subtask" && isAssistant && isCompleted) {
              const childID = `subtask:${part.id}`;
              const status = hasError ? "error" : "done";
              if (markChildStatus(next, childID, status, completedAt))
                changed = true;
            }
          }
        }
      }

      if (backfillHydratedTargetSessionIDs(next, currentSessionID)) {
        changed = true;
      }

      const refreshed = refreshLiveState(next);
      if (!changed && !refreshed) return current;
      stateToPersist = next;
      return next;
    });
    if (!isValid()) return false;
    const terminalFlush = stateToPersist
      ? persistStateSnapshot(persistence, stateToPersist, true)
      : undefined;
    await terminalFlush?.catch(() => undefined);
    if (topLevelHydrationFailed || childHydrationFailed) return false;
    return true;
  } catch (err) {
    debugLog({
      kind: "hydration.error",
      sessionID: currentSessionID,
      error: String(err),
    });
    return false;
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
  messages: unknown[],
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

export function selectRunningReconcileCandidates(input: {
  state: StatuslineState;
  currentSessionID?: string;
  hydratingSessionIDs?: ReadonlySet<string>;
  nowMs: number;
  maxCandidates: number;
  lookup?: ChildLookup;
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
  const prioritizedForSession = prioritized.filter((child) =>
    input.currentSessionID ? child.parentID === input.currentSessionID : true,
  );

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
    const age = ageByID.get(child.id)!;
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
  const persistence = createPersistenceCoordinator<StatuslineState>(
    async (snapshot) => {
      await saveState(statePath, snapshot);
      const nextText = renderStatusLine(snapshot);
      // Skip status.txt write when the rendered summary is unchanged — the
      // aggregate text only changes on status/visibility transitions, which
      // are rare relative to detail-only event bursts.
      if (nextText !== lastStatusText) {
        lastStatusText = nextText;
        await saveStatusText(textPath, nextText);
      }
    },
    { settleDelayMs: 150 },
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
    const routeSessionID = resolveRouteSessionID(api);
    const ids = childIDs ?? Object.keys(current.children);
    const candidates = [...new Set(ids)]
      .map((childID) => current.children[childID])
      .filter((child): child is ChildSessionState => child !== undefined)
      .filter(
        (child) => child.status === "running" || !hasTokenTotal(child.tokens),
      )
      .sort((left, right) => {
        const leftCurrent = left.parentID === routeSessionID ? 1 : 0;
        const rightCurrent = right.parentID === routeSessionID ? 1 : 0;
        if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
        const leftRunning = left.status === "running" ? 1 : 0;
        const rightRunning = right.status === "running" ? 1 : 0;
        if (leftRunning !== rightRunning) return rightRunning - leftRunning;
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      });

    for (const child of candidates) {
      const updatedAtMs = Date.parse(child.updatedAt);
      tokenHydrationQueue.enqueue({
        childID: child.id,
        baseline: child.tokens ? { ...child.tokens } : undefined,
        generation: routeGeneration,
        signal: routeHydrationSignal,
        priority:
          (child.parentID === routeSessionID ? 2_000_000_000_000_000 : 0) +
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

      const hydrated = await hydratePreviousSubagents(
        api,
        sessionID,
        statePath,
        textPath,
        setState,
        persistence,
        {
          signal: generationSignal,
          isValid: isCurrentHydration,
          getCurrentState: state,
        },
      );
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
