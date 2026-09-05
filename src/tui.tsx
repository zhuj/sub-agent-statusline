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
  extractLatestAssistantModel,
  extractTaskToolEvidence,
} from "./events.js";
import {
  createEventChildIndex,
  type EventChildIndex,
} from "./event-child-index.js";
import {
  byPriority,
  projectCorrelatedSubagentWorkItems,
  visibleProjectedSubagentWorkItems,
} from "./render.js";
import { correlateSubagentWorkItems } from "./subagent-classification.js";
import {
  analyzePersistedParentMessages,
  canSafelyCloseNoTargetPersistedCandidate,
  deriveOpenCodeSessionStatus,
  hasRecentMessageActivity,
  nextBackoffState,
  parseStaleRunningThresholdMs as parseConfiguredStaleRunningThresholdMs,
  resolvePersistedStaleSubtaskFromParentAnalysis,
  resolveSessionStatusWithMessageSummary,
  shouldApplyStaleRunningFallback,
  shouldSkipCandidateForBackoff,
  summarizeSessionMessages,
  type PersistedParentMessageAnalysis,
  type PersistedStaleSubtaskCandidate,
  type RunningReconcileCacheEntry,
  type RunningReconcileEvidence,
  type SessionMessageSummary,
} from "./reconcile.js";
import {
  focusPromptWithDeferredRetry,
  resolveSidebarReturnFocusAction,
  resolveSiblingSidebarRefocus,
  shouldReleaseSidebarListFocus,
  type PendingSidebarRefocus,
} from "./tui-focus.js";
import {
  createEmptyState,
  markChildStatus,
  refreshDerivedFields,
  setChildModel,
  upsertChildDetails,
  type ChildTokenState,
  type ChildSessionState,
  type StatusCounts,
  type StatuslineState,
} from "./state.js";
import { registerSubagentCommands } from "./tui-commands.js";
import {
  createHydrationTransactionIndex,
  createHydrationMerger,
  type HydrationTransactionIndex,
} from "./tui-hydration-index.js";
import { createDiscoveryMetadataLoader } from "./tui-discovery-metadata.js";
import { buildTuiRowMetrics } from "./tui-row-metrics.js";
import type { SidebarScrollRowLayout } from "./tui-row-metrics.js";
import { createRunningReconcileSelector, descendantIDsFromChildren } from "./tui-reconcile.js";
import { hydrateStateTokensFromTuiState } from "./tui-token-hydration.js";
import { t } from "./i18n.js";

export {
  formatChildModelLine,
  formatChildRowLine,
  formatTerminalChildRowLine,
  rowWidthBudget,
  subagentRowHeight,
  wrapCompactText,
} from "./tui-row-metrics.js";
export type { SidebarScrollRowLayout } from "./tui-row-metrics.js";

const TUI_PLUGIN_ID = "subagent-statusline.tui";
const ELAPSED_TICK_MS = 10_000;
const MAINTENANCE_TICK_MS = 10_000;
const HYDRATE_RETRY_BASE_DELAY_MS = 1000;
const HYDRATE_RETRY_MAX_DELAY_MS = 30_000;
const HYDRATE_RETRY_MAX_ATTEMPTS = 6;
const HYDRATE_MAX_DESCENDANT_DEPTH = 32;
const HYDRATE_MAX_DESCENDANT_SESSIONS = 1_500;
const RUNNING_RECONCILE_MAINTENANCE_INTERVAL_MS = 10_000;
const RUNNING_RECONCILE_MAX_CANDIDATES = 32;
const RUNNING_RECONCILE_INITIAL_BACKOFF_MS = 10_000;
const RUNNING_RECONCILE_MAX_BACKOFF_MS = 5 * 60_000;
const RUNNING_RECONCILE_MESSAGE_AGE_GATE_MS = 60_000;
const RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS = 5 * 60_000;
const CLOCK_ICON = "⏱";
const TOKEN_ICON = "⍄";
const SIDEBAR_ARROW_EXPANDED = "▼";
const SIDEBAR_ARROW_COLLAPSED = "▶";
const SUBAGENTS_EXPANDED_KV_KEY = "subagents.sidebar.expanded";
const SUBAGENTS_SECTION_ENABLED_KV_KEY = "subagents.sidebar.enabled";
const SUBAGENTS_MAX_VISIBLE_ROWS = 8;
const SUBAGENTS_RUNNING_ROW_HEIGHT = 3;
const SUBAGENTS_TERMINAL_ROW_HEIGHT = 2;
const SUBAGENTS_MODEL_ROW_HEIGHT = 1;
const SUBAGENTS_ROW_GAP = 0;
const SUBAGENTS_MAX_LIST_HEIGHT =
  SUBAGENTS_MAX_VISIBLE_ROWS *
    (SUBAGENTS_RUNNING_ROW_HEIGHT + SUBAGENTS_MODEL_ROW_HEIGHT) +
  (SUBAGENTS_MAX_VISIBLE_ROWS - 1) * SUBAGENTS_ROW_GAP;
const INACTIVE_SUBAGENT_OPACITY = 0.65;
const SIDEBAR_FOCUS_INDICATOR = "●";

interface SidebarScrollRegistration {
  getScrollbox: () => ScrollBoxRenderable | undefined;
  getAnchor: () => SidebarScrollAnchor | undefined;
  getRows: () => SidebarScrollRowLayout[];
  getLeadingHeight: () => number;
  offsetTop: number;
  anchor?: SidebarScrollAnchor;
  restoreFramesRemaining: number;
}

export interface SidebarScrollAnchor {
  childIDs: string[];
  intraRowOffset: number;
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
  rows: SidebarScrollRowLayout[];
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
  rows: SidebarScrollRowLayout[];
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
  rows?: SidebarScrollRowLayout[];
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

interface RehydratedTokenCacheEntry {
  attempts: number;
  checkedAtMs: number;
  tokens?: ChildTokenState;
}

function cloneState(state: StatuslineState): StatuslineState {
  return {
    updatedAt: state.updatedAt,
    totalExecuted: state.totalExecuted,
    countedChildIDs: { ...state.countedChildIDs },
    children: { ...state.children },
  };
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

function refreshLiveState(state: StatuslineState): boolean {
  const beforeChildIDs = new Set(Object.keys(state.children));
  refreshDerivedFields(state);

  if (Object.keys(state.children).length !== beforeChildIDs.size) {
    return true;
  }

  for (const childID of beforeChildIDs) {
    if (!state.children[childID]) return true;
  }

  return false;
}

export function runTuiStateMaintenance(
  api: TuiPluginApi,
  current: StatuslineState,
): StatuslineState {
  const next = cloneState(current);
  const hydrated = hydrateStateTokensFromTuiState(api, next);
  const refreshed = refreshLiveState(next);
  return hydrated || refreshed ? next : current;
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
): string | undefined {
  const messageMatches = Object.values(state.children).filter(
    (candidate) =>
      candidate.id.startsWith("ses_") &&
      candidate.parentID === synthetic.parentID &&
      synthetic.messageID &&
      candidate.messageID === synthetic.messageID,
  );
  if (messageMatches.length === 1) return messageMatches[0].id;

  const parentMatches = Object.values(state.children).filter(
    (candidate) =>
      candidate.id.startsWith("ses_") &&
      candidate.parentID === synthetic.parentID,
  );
  if (parentMatches.length === 1) return parentMatches[0].id;

  return undefined;
}

export function backfillHydratedTargetSessionIDs(
  state: StatuslineState,
  parentSessionID: string,
  index = createHydrationTransactionIndex(Object.values(state.children)),
): boolean {
  let changed = false;

  for (const child of index.childrenOf(parentSessionID)) {
    if (resolveChildTargetSessionID(child)) continue;
    if (child.source === "session" || child.id.startsWith("ses_")) {
      const replacement = { ...child, targetSessionID: child.id };
      state.children[child.id] = replacement;
      index.upsert(replacement);
      changed = true;
      continue;
    }

    const syntheticTarget = index.resolveSyntheticTarget(child);
    if (syntheticTarget) {
      const replacement = { ...child, targetSessionID: syntheticTarget };
      state.children[child.id] = replacement;
      index.upsert(replacement);
      changed = true;
    }
  }

  if (changed) {
    state.updatedAt = new Date().toISOString();
  }

  return changed;
}

function syncHydrationChild(
  state: StatuslineState,
  index: HydrationTransactionIndex,
  childID: string,
): void {
  const child = state.children[childID];
  if (child) index.upsert(child);
  else index.remove(childID);
}

function syncHydrationAndEventChild(
  state: StatuslineState,
  hydrationIndex: HydrationTransactionIndex,
  eventIndex: EventChildIndex,
  childID: string,
): void {
  syncHydrationChild(state, hydrationIndex, childID);
  const child = state.children[childID];
  if (child) eventIndex.upsert(child);
  else eventIndex.remove(childID);
}

function syncHydrationParent(
  state: StatuslineState,
  index: HydrationTransactionIndex,
  parentID: string,
): void {
  for (const indexedChild of index.childrenOf(parentID)) {
    if (state.children[indexedChild.id] !== indexedChild) {
      syncHydrationChild(state, index, indexedChild.id);
    }
  }
}

function resolveHydratedSyntheticTarget(
  state: StatuslineState,
  index: HydrationTransactionIndex,
  childID: string,
): boolean {
  const child = state.children[childID];
  if (!child || child.id.startsWith("ses_")) return false;

  const targetSessionID = index.resolveSyntheticTarget(child);
  if (!targetSessionID || resolveChildTargetSessionID(child)) return false;

  const replacement = { ...child, targetSessionID };
  state.children[childID] = replacement;
  index.upsert(replacement);
  return true;
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

export interface TuiSubagentSnapshot {
  visibleChildren: ChildSessionState[];
  visibleChildrenByID: ReadonlyMap<string, ChildSessionState>;
  visibleCounts: StatusCounts;
  totalExecuted: number;
  showingOtherSessions: boolean;
}

function descendantChildren(
  children: ChildSessionState[],
  parentSessionID: string,
): ChildSessionState[] {
  const childrenByParent = new Map<string, ChildSessionState[]>();
  for (const child of children) {
    const siblings = childrenByParent.get(child.parentID) ?? [];
    siblings.push(child);
    childrenByParent.set(child.parentID, siblings);
  }

  const ordered: ChildSessionState[] = [];
  const visited = new Set<string>();
  const pending = [
    ...(childrenByParent.get(parentSessionID) ?? [])
      .sort(byPriority)
      .reverse(),
  ];

  while (pending.length > 0 && ordered.length < HYDRATE_MAX_DESCENDANT_SESSIONS) {
    const child = pending.pop();
    if (!child || visited.has(child.id)) continue;
    visited.add(child.id);
    ordered.push(child);

    const descendants = childrenByParent.get(child.id);
    if (!descendants) continue;
    pending.push(...[...descendants].sort(byPriority).reverse());
  }

  return ordered;
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
  const scopedChildren = input.sessionID
    ? descendantChildren(allChildren, input.sessionID)
    : allChildren;
  const executions = correlateSubagentWorkItems(scopedChildren);
  const projectedChildren = projectCorrelatedSubagentWorkItems(executions);
  const visibleChildren = visibleProjectedSubagentWorkItems(
    projectedChildren,
    nowMs,
    options,
  );
  // Projected rows decide visibility; scoped snapshots retain original metadata.
  const visibleChildIDs = new Set(visibleChildren.map((child) => child.id));
  const ownVisibleChildren = input.sessionID
    ? scopedChildren.filter((child) => visibleChildIDs.has(child.id))
    : visibleChildren.sort(byPriority);
  const visibleCounts: StatusCounts = { running: 0, done: 0, error: 0 };
  for (const { real } of executions) {
    visibleCounts[real.status] += 1;
  }
  const totalExecuted = input.sessionID
    ? executions.filter(
        ({ executionID }) => input.state.countedChildIDs[executionID],
      ).length
    : executions.length;

  return {
    visibleChildren: ownVisibleChildren,
    visibleChildrenByID: new Map(
      ownVisibleChildren.map((child) => [child.id, child]),
    ),
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
  const rowMetrics = createMemo(() =>
    buildTuiRowMetrics({
      children: visibleChildren(),
      childrenByID: props.state().children,
      expanded: props.expanded(),
      nowMs: props.nowMs(),
      sidebarWidth: props.sidebarWidth?.(),
      providers: props.api.state.provider,
      ancestorSessionID: props.sessionID,
    }),
  );

  const visibleChildIDs = createMemo(() =>
    visibleChildren().map((child) => child.id),
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

  const listHeight = createMemo(() => {
    const metrics = [...rowMetrics().values()];
    const contentHeight =
      metrics.reduce((height, metric) => height + metric.height, 0) +
      Math.max(0, metrics.length - 1) * SUBAGENTS_ROW_GAP;

    return Math.max(1, Math.min(SUBAGENTS_MAX_LIST_HEIGHT, contentHeight));
  });

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
      const ids = visibleChildIDs();
      if (preferredChildID && ids.includes(preferredChildID)) {
        setSelectedChildID(preferredChildID);
      } else if (!selectedChildID() && ids[0]) {
        setSelectedChildID(ids[0]);
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
    const ids = visibleChildIDs();
    const current = selectedChildID();
    if (ids.length === 0) {
      if (current) setSelectedChildID(undefined);
      return;
    }
    if (!current || !ids.includes(current)) setSelectedChildID(ids[0]);
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

  const rowTopForIndex = (index: number): number => {
    let top = 0;
    const rows = rowLayouts();
    for (let i = 0; i < index; i += 1) {
      const row = rows[i];
      if (row) top += row.height + SUBAGENTS_ROW_GAP;
    }
    return top;
  };

  const rowLayouts = (): SidebarScrollRowLayout[] =>
    [...rowMetrics().values()].map((metric) => metric.layout);

  const currentSidebarScrollAnchor = (): SidebarScrollAnchor | undefined => {
    if (!scrollbox) return undefined;
    const rows = rowLayouts();
    if (rows.length === 0) return undefined;

    const viewportTop = clampedScrollTop(scrollbox, scrollbox.scrollTop);
    let top = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      const rowBottom = top + row.height;
      if (rowBottom > viewportTop) {
        return {
          childIDs: rows.slice(index).map((candidate) => candidate.id),
          intraRowOffset: Math.max(0, viewportTop - top),
        };
      }
      top = rowBottom + SUBAGENTS_ROW_GAP;
    }

    const lastRow = rows[rows.length - 1];
    return lastRow ? { childIDs: [lastRow.id], intraRowOffset: 0 } : undefined;
  };

  const scrollChildIntoView = (childID: string | undefined): void => {
    if (!scrollbox) return;
    const selectedIndex = visibleChildIDs().findIndex((id) => id === childID);
    if (selectedIndex < 0) return;
    const selectedChild = visibleChildren()[selectedIndex];
    if (!selectedChild) return;

    const rowTop = rowTopForIndex(selectedIndex);
    const rowBottom =
      rowTop + (rowMetrics().get(selectedChild.id)?.height ?? 0);
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
  };

  const scrollSelectedChildIntoView = (): void => {
    if (!listFocusModeActive()) return;
    scrollChildIntoView(selectedChildID());
  };

  const moveSelection = (delta: number): void => {
    const ids = visibleChildIDs();
    if (ids.length === 0) return;
    const currentIndex = ids.findIndex((id) => id === selectedChildID());
    const fallbackIndex = delta > 0 ? 0 : ids.length - 1;
    const nextIndex = Math.max(
      0,
      Math.min(
        ids.length - 1,
        currentIndex < 0 ? fallbackIndex : currentIndex + delta,
      ),
    );
    setSelectedChildID(ids[nextIndex]);
    scrollChildIntoView(ids[nextIndex]);
  };

  const rowActivations = new Map<string, () => void>();

  const resolveNavigableChildTargetSessionID = (
    child: ChildSessionState,
  ): string | undefined =>
    resolveChildTargetSessionID(child) ??
    resolveSyntheticTargetFromHydratedState(props.state(), child);

  const selectedTargetSessionID = (): string | undefined => {
    const selected = visibleChildren().find(
      (child) => child.id === selectedChildID(),
    );
    return selected
      ? resolveNavigableChildTargetSessionID(selected)
      : undefined;
  };

  const activateSelectedChild = (): void => {
    const selectedID = selectedChildID();
    const activateRow = selectedID ? rowActivations.get(selectedID) : undefined;
    if (activateRow) {
      activateRow();
      return;
    }
    navigateToSessionTarget(props.api, selectedTargetSessionID());
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
      if (visibleChildIDs().includes(childRowID)) {
        scrollChildIntoView(childRowID);
      } else {
        scrollbox.scrollTop = 0;
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
    rowMetrics();

    restorePreservedScroll();
  });

  const ChildRow = (rowProps: { childID: string }) => {
    const metric = createMemo(() => rowMetrics().get(rowProps.childID));
    const child = createMemo(() => metric()?.child);
    const [hovered, setHovered] = createSignal(false);
    const [focused, setFocused] = createSignal(false);
    const targetSessionID = createMemo(() => {
      const currentChild = child();
      return currentChild
        ? resolveNavigableChildTargetSessionID(currentChild)
        : undefined;
    });
    const indentationWidth = createMemo(
      () => metric()?.indentationWidth ?? 0,
    );
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
      const currentMetric = metric();
      return currentMetric?.kind === "running"
        ? currentMetric.line
        : { labelLines: [""], elapsed: "00:00", meta: "" };
    });
    const terminalLine = createMemo(() => {
      const currentMetric = metric();
      return currentMetric?.kind === "terminal"
        ? currentMetric.line
        : { label: "", meta: "00:00" };
    });
    const rowHeight = createMemo(
      () => metric()?.height ?? SUBAGENTS_TERMINAL_ROW_HEIGHT,
    );
    const modelLine = createMemo(() => metric()?.modelLine);
    const activate = () => {
      const currentChild = child();
      const target = targetSessionID();
      if (currentChild && target) {
        props.onNavigateToChild({
          parentSessionID: currentChild.parentID,
          childSessionID: target,
          childRowID: rowProps.childID,
          showCompletedHistory: showCompletedHistory(),
        });
      }
      snapshotSidebarScrollOffsets();
      navigateToSessionTarget(props.api, target);
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
        flexDirection="column"
        height={rowHeight()}
        paddingLeft={indentationWidth()}
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
      }}
    >
      <box flexDirection="row">
        <text
          fg={props.theme.text}
          selectable={false}
          onMouseDown={props.onToggleExpanded}
        >{`${props.expanded() ? SIDEBAR_ARROW_EXPANDED : SIDEBAR_ARROW_COLLAPSED} ${t("subagents")}`}</text>
        <Show when={listFocused()}>
          <text
            fg={props.theme.accent}
            selectable={false}
            onMouseDown={props.onToggleExpanded}
          >{` ${SIDEBAR_FOCUS_INDICATOR}`}</text>
        </Show>
      </box>
      <AggregateBar />

      <Show when={props.expanded()}>
        <scrollbox
          ref={(element) => {
            scrollbox = element;
            restorePreservedScroll();
          }}
          height={listHeight()}
          scrollY
          viewportCulling={false}
        >
          <box flexDirection="column" rowGap={SUBAGENTS_ROW_GAP}>
            <For each={visibleChildIDs()}>
              {(childID: string) => <ChildRow childID={childID} />}
            </For>
          </box>
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

interface HydratedSession {
  info: Record<string, unknown>;
  id: string;
  parentID: string;
}

interface HydratedSessionTree {
  sessions: HydratedSession[];
  topLevelFailed: boolean;
  descendantFailed: boolean;
}

async function collectHydratedSessionTree(
  api: TuiPluginApi,
  currentSessionID: string,
  directory: string,
  shouldContinue: () => boolean,
): Promise<HydratedSessionTree> {
  const sessionClient = api.client.session;
  const pending: Array<{ sessionID: string; depth: number }> = [
    { sessionID: currentSessionID, depth: 0 },
  ];
  const seenSessionIDs = new Set<string>([currentSessionID]);
  const sessions: HydratedSession[] = [];
  let topLevelFailed = false;
  let descendantFailed = false;

  for (
    let index = 0;
    index < pending.length && sessions.length < HYDRATE_MAX_DESCENDANT_SESSIONS;
  ) {
    if (!shouldContinue()) break;
    const requests = pending.slice(index, index + 8);
    index += requests.length;
    const results = await Promise.all(requests.map(async (request) => ({
      request,
      response: await safeReadAsync(() =>
        sessionClient?.children?.({ sessionID: request.sessionID, directory }) ??
          Promise.resolve({ data: [] }),
      ),
    })));
    if (!shouldContinue()) break;
    for (const { request, response } of results) {
      if (sessions.length >= HYDRATE_MAX_DESCENDANT_SESSIONS) break;
      if (!response) {
        if (request.depth === 0) topLevelFailed = true;
        else descendantFailed = true;
        continue;
      }

      const rawChildren = Array.isArray(response.data) ? response.data : [];
      if (request.depth >= HYDRATE_MAX_DESCENDANT_DEPTH) continue;

      for (const rawChild of rawChildren) {
        if (sessions.length >= HYDRATE_MAX_DESCENDANT_SESSIONS) break;
        const info = asRecord(rawChild);
        const id = info && isSessionTarget(info.id) ? info.id : undefined;
        const parentID =
          info && typeof info.parentID === "string" && info.parentID.length > 0
            ? info.parentID
            : undefined;
        if (!info || !id || !parentID || seenSessionIDs.has(id)) continue;

        seenSessionIDs.add(id);
        sessions.push({ info, id, parentID });
        pending.push({
          sessionID: id,
          depth: request.depth + 1,
        });
      }
    }
  }

  return { sessions, topLevelFailed, descendantFailed };
}

export async function hydratePreviousSubagents(
  api: TuiPluginApi,
  currentSessionID: string,
  setState: (fn: (prev: StatuslineState) => StatuslineState) => void,
  shouldContinue: () => boolean = () => true,
  readState?: () => StatuslineState,
): Promise<boolean> {
  if (!currentSessionID || !shouldContinue()) return false;

  const baseline = readState ? cloneState(readState()) : undefined;

  try {
    const directory = api.state.path.directory;
    const sessionClient = api.client.session;
    const [sessionTree, messagesResp, statusResp] = await Promise.all([
      collectHydratedSessionTree(api, currentSessionID, directory, shouldContinue),
      safeReadAsync(
        () =>
          sessionClient?.messages?.({
            sessionID: currentSessionID,
            directory,
          }) ?? Promise.resolve({ data: [] }),
      ),
      safeReadAsync(
        () =>
          sessionClient?.status?.({ directory }) ??
          Promise.resolve({ data: {} }),
      ),
    ]);

    if (!shouldContinue()) return false;
    const topLevelHydrationFailed =
      sessionTree.topLevelFailed || !messagesResp || !statusResp;
    const statusHydrationFailed = !statusResp;
    const parentMessageHydrationFailed = !messagesResp;
    const messages = Array.isArray(messagesResp?.data) ? messagesResp.data : [];
    const allStatuses = { ...asRecord(statusResp?.data) };
    const parentMessagesBySession = new Map<string, unknown[]>([
      [currentSessionID, messages],
    ]);
    let childHydrationFailed = false;
    const fetchChildMessages = async (session: HydratedSession) => {
        const childMessagesResp = await safeReadAsync(
          () =>
            sessionClient?.messages?.({ sessionID: session.id, directory }) ??
            Promise.resolve({ data: [] }),
        );
        let fetchFailed = false;
        if (!childMessagesResp) {
          childHydrationFailed = true;
          fetchFailed = true;
        }
        const childMessages = Array.isArray(childMessagesResp?.data)
          ? childMessagesResp.data
          : [];
        parentMessagesBySession.set(session.id, childMessages);
        return {
          session,
          ...summarizeSessionMessages(childMessages),
          model: extractLatestAssistantModel(childMessages),
          fetchFailed,
        };
      };
    const childMessageResults: Array<Awaited<ReturnType<typeof fetchChildMessages>>> = [];
    const active: HydratedSession[] = [];
    const remaining: HydratedSession[] = [];
    for (const session of sessionTree.sessions) {
      const group = deriveSessionChildStatus(allStatuses[session.id]) === "running" ? active : remaining;
      group.push(session);
    }
    const hydrationOrder = active.concat(remaining);
    const buildDraft = (
      current: StatuslineState,
      selectedSessions: HydratedSession[],
    ): StatuslineState => {
      const childMessageSummaryByID = new Map(
        childMessageResults.map((result) => [result.session.id, result]),
      );
      const parentTaskEvidenceByChildID = new Map<string, ParentTaskEvidence>();
      for (const [parentSessionID, parentMessages] of parentMessagesBySession) {
        for (const [childID, evidence] of collectParentTaskEvidenceByChildSessionID(
          parentMessages,
          parentSessionID,
        )) {
          parentTaskEvidenceByChildID.set(childID, evidence);
        }
      }

      const next = cloneState(current);
      const hydrationIndex = createHydrationTransactionIndex(
        Object.values(next.children),
      );
      const eventIndex = createEventChildIndex(Object.values(next.children));
      let changed = false;

      for (const hydratedSession of selectedSessions) {
        const session = hydratedSession.info;
        const status = allStatuses[hydratedSession.id];
        const sessionStatus = deriveSessionChildStatus(status);
        const childSummary = childMessageSummaryByID.get(hydratedSession.id);
        const hasHydrationEvidence = shouldHydrateSessionChild({
          childID: hydratedSession.id,
          sessionStatus,
          childSummary,
          parentTaskEvidenceByChildID,
        });
        const parentTaskEvidence = parentTaskEvidenceByChildID.get(
          hydratedSession.id,
        );
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
          const existing = next.children[hydratedSession.id];
          if (
            !statusHydrationFailed &&
            !parentMessageHydrationFailed &&
            !!childSummary &&
            !childSummary.fetchFailed &&
            existing?.parentID === hydratedSession.parentID &&
            existing.source === "session" &&
            existing.status === "running"
          ) {
            delete next.children[hydratedSession.id];
            hydrationIndex.remove(hydratedSession.id);
            eventIndex.remove(hydratedSession.id);
            changed = true;
          }
          continue;
        }

        const fakeEvent = {
          type: "session.created",
          properties: {
            sessionID: hydratedSession.id,
            info: session,
          },
        };
        if (applySubagentEvent(next, fakeEvent, eventIndex)) {
          syncHydrationChild(next, hydrationIndex, hydratedSession.id);
          changed = true;
        }
        if (childSummary?.model) {
          if (
            setChildModel(
              next,
              hydratedSession.id,
              childSummary.model.model,
              childSummary.model.updatedAt,
              eventIndex.matchingIDs(hydratedSession.id),
            )
          ) {
            syncHydrationAndEventChild(
              next,
              hydrationIndex,
              eventIndex,
              hydratedSession.id,
            );
            changed = true;
          }
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
              hydratedSession.id,
              resolvedStatus.status,
              resolvedStatus.endedAt ??
                parentTaskEvidence?.endedAt ??
                statusEndedAt,
              eventIndex.matchingIDs(hydratedSession.id),
            )
          ) {
            syncHydrationAndEventChild(
              next,
              hydrationIndex,
              eventIndex,
              hydratedSession.id,
            );
            changed = true;
          }
          continue;
        }

        if (
          !sessionStatus &&
          !statusHydrationFailed &&
          explicitCompletionEvidence
        ) {
          const childStatus = childSummary?.hasError ? "error" : "done";
          if (
            markChildStatus(
              next,
              hydratedSession.id,
              childStatus,
              fallbackEndedAt,
              eventIndex.matchingIDs(hydratedSession.id),
            )
          ) {
            syncHydrationAndEventChild(
              next,
              hydrationIndex,
              eventIndex,
              hydratedSession.id,
            );
            changed = true;
          }
        }
      }

      for (const [parentSessionID, parentMessages] of parentMessagesBySession) {
        for (const rawMessage of parentMessages) {
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
                  sessionID: parentSessionID,
                  info: eventInfo,
                  part: partWithMessageID,
                },
              };
              if (applySubagentEvent(next, fakeEvent, eventIndex)) {
                const partID =
                  typeof part.id === "string" ? part.id : undefined;
                if (partID) {
                  const replayedChildID = `${part.type}:${partID}`;
                  syncHydrationChild(
                    next,
                    hydrationIndex,
                    replayedChildID,
                  );
                  resolveHydratedSyntheticTarget(
                    next,
                    hydrationIndex,
                    replayedChildID,
                  );
                  const replayedChild = next.children[replayedChildID];
                  if (replayedChild) eventIndex.upsert(replayedChild);
                }
                changed = true;
              }

              if (part.type === "subtask" && isAssistant && isCompleted) {
                const childID = `subtask:${part.id}`;
                const status = hasError ? "error" : "done";
                if (
                  markChildStatus(
                    next,
                    childID,
                    status,
                    completedAt,
                    eventIndex.matchingIDs(childID),
                  )
                ) {
                  syncHydrationAndEventChild(
                    next,
                    hydrationIndex,
                    eventIndex,
                    childID,
                  );
                  changed = true;
                }
              }
            }
          }
        }
      }

      for (const parentSessionID of parentMessagesBySession.keys()) {
        syncHydrationParent(next, hydrationIndex, parentSessionID);
        if (
          backfillHydratedTargetSessionIDs(
            next,
            parentSessionID,
            hydrationIndex,
          )
        ) {
          changed = true;
        }
      }

      const refreshed = refreshLiveState(next);
      if (!changed && !refreshed) return current;
      return next;
    };

    let groups = [hydrationOrder];
    if (baseline && active.length > 0) {
      const byID = new Map(sessionTree.sessions.map((session) => [session.id, session]));
      const requiredIDs = new Set<string>();
      for (const session of active) {
        let ancestor: HydratedSession | undefined = session;
        while (ancestor && !requiredIDs.has(ancestor.id)) {
          requiredIDs.add(ancestor.id);
          if (!Object.hasOwn(allStatuses, ancestor.id)) allStatuses[ancestor.id] = { type: "idle" };
          ancestor = byID.get(ancestor.parentID);
        }
      }
      const deferred = remaining.filter((session) => !requiredIDs.has(session.id));
      if (deferred.length > 0) {
        groups = [hydrationOrder.filter((session) => requiredIDs.has(session.id)), deferred];
      }
    }
    const merger = baseline ? createHydrationMerger(baseline) : undefined;
    const fetchedIDs = new Set<string>();
    for (const group of groups) {
      for (let index = 0; index < group.length; index += 8) {
        if (!shouldContinue()) return false;
        const chunk = group.slice(index, index + 8);
        childMessageResults.push(...await Promise.all(chunk.map(fetchChildMessages)));
        for (const session of chunk) fetchedIDs.add(session.id);
      }
      if (!shouldContinue()) return false;
      const selectedSessions = sessionTree.sessions.filter((session) => fetchedIDs.has(session.id));
      snapshotSidebarScrollOffsets();
      setState((current) => {
        const draft = buildDraft(baseline ?? current, selectedSessions);
        return merger ? merger.merge(current, draft) : draft;
      });
    }
    if (
      topLevelHydrationFailed ||
      sessionTree.descendantFailed ||
      childHydrationFailed
    )
      return false;
    return true;
  } catch {
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

export function discoverCachedBusyDescendants(
  state: StatuslineState,
  rootID: string | undefined,
  statuses: Record<string, unknown>,
  readSession: (id: string) => unknown,
  completeStatusSnapshot = false,
): boolean {
  if (!rootID) return false;
  const connected = new Set([rootID, ...descendantIDsFromChildren(Object.values(state.children), rootID)]);
  const buckets = new Map<string, Record<string, unknown>[]>();
  const pending = Object.keys(statuses).filter((id) =>
    deriveSessionChildStatus(statuses[id]) === "running",
  );
  const attempted = new Set<string>();
  const observedStatuses = new Map<string, unknown>();
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const id = pending[cursor];
    if (id === undefined || attempted.has(id)) continue;
    attempted.add(id);
    if (connected.has(id) || !id.startsWith("ses_")) continue;
    const existing = state.children[id];
    if (existing) {
      pending.push(existing.parentID);
      continue;
    }
    // SessionStatus.list omits idle entries; failed/cache reads do not prove idle.
    const status = Object.hasOwn(statuses, id) ? statuses[id]
      : completeStatusSnapshot ? { type: "idle" } : undefined;
    if (deriveSessionChildStatus(status) === undefined) continue;
    const info = asRecord(readSession(id));
    if (!info || info.id !== id || typeof info.parentID !== "string") continue;
    observedStatuses.set(id, status);
    const bucket = buckets.get(info.parentID) ?? [];
    bucket.push(info);
    buckets.set(info.parentID, bucket);
    pending.push(info.parentID);
  }
  if (buckets.size === 0) return false;
  const index = createEventChildIndex(Object.values(state.children));
  const queue = Array.from(connected);
  let created = 0;
  let changed = false;
  for (let cursor = 0; cursor < queue.length && created < 32; cursor += 1) {
    const parentID = queue[cursor];
    if (parentID === undefined) continue;
    for (const info of buckets.get(parentID) ?? []) {
      if (created >= 32) break;
      const id = info.id;
      if (typeof id !== "string" || connected.has(id)) continue;
      changed = applySubagentEvent(state, { type: "session.created", properties: { info } }, index) || changed;
      changed = applySubagentEvent(state, {
        type: "session.status",
        properties: { sessionID: id, status: observedStatuses.get(id) },
      }, index) || changed;
      if (state.children[id]) {
        created += 1;
        connected.add(id);
        queue.push(id);
      }
    }
  }
  return changed;
}

export function resumeKnownBusySessions(
  state: StatuslineState,
  snapshot: StatuslineState,
  statuses: Record<string, unknown>,
): boolean {
  const ids = Object.keys(statuses).filter((id) => {
    const observed = snapshot.children[id];
    const latest = state.children[id];
    return id.startsWith("ses_") && observed && latest &&
      observed.status !== "running" && latest.status === observed.status &&
      latest.updatedAt === observed.updatedAt && latest.endedAt === observed.endedAt &&
      deriveSessionChildStatus(statuses[id]) === "running";
  });
  if (ids.length === 0) return false;
  const index = createEventChildIndex(Object.values(state.children));
  let changed = false;
  for (const id of ids) {
    changed = applySubagentEvent(state, {
      type: "session.status",
      properties: { sessionID: id, status: { type: "busy" } },
    }, index) || changed;
  }
  return changed;
}

export async function probeRunningEvidence(input: {
  api: TuiPluginApi;
  targetSessionID: string;
  directory: string;
  candidateAgeMs: number;
  nowMs: number;
  readDirectoryStatus?: () => Promise<{ data?: unknown } | undefined>;
  statusOverride?: unknown;
}): Promise<RunningReconcileEvidence> {
  let probeFailed = false;

  const directStatus = input.statusOverride ?? safeRead(() =>
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

  const statusResp = input.readDirectoryStatus
    ? await input.readDirectoryStatus()
    : await safeReadAsync(() =>
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
  let previousRouteSessionID: string | undefined;
  let pendingSidebarRefocus: PendingSidebarRefocus | undefined;
  let pendingRefocusConsumed = false;
  let activePromptRef: TuiPromptRef | undefined;

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
    });
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
    setTimeout(() => {
      focusVisibleSidebarSubagentList();
    }, 0);
  };

  const toggleSidebarCompletedHistory = (): void => {
    api.ui.dialog.clear();
    setSubagentsSectionEnabled(true);
    setSubagentsExpanded(true);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, true);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, true);
    setTimeout(() => {
      toggleVisibleSidebarCompletedHistory();
    }, 0);
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

    if (previousRouteSessionID && previousRouteSessionID !== routeSessionID) {
      resetHydrateRetry(previousRouteSessionID);
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
      hydrateRetryPendingSessions().has(sessionID)
    ) {
      return;
    }

    setHydratingSessions((prev) => {
      const next = new Set(prev);
      next.add(sessionID);
      return next;
    });

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
        setState,
        () => !disposed,
        () => state(),
      );
      if (disposed) {
        clearHydrateRetryTimeout(sessionID);
        finishHydrating();
        return;
      }
      if (hydrated) {
        resetHydrateRetry(sessionID);
        setHydratedSessions((prev) => {
          const next = new Set(prev);
          next.add(sessionID);
          return next;
        });
        finishHydrating();
        return;
      }

      const attempts = hydrateRetryAttempts().get(sessionID) ?? 0;

      const delayMs = Math.min(
        HYDRATE_RETRY_MAX_DELAY_MS,
        HYDRATE_RETRY_BASE_DELAY_MS * 2 ** attempts,
      );

      setHydrateRetryAttempts((prev) => {
        const next = new Map(prev);
        next.set(sessionID, Math.min(attempts + 1, HYDRATE_RETRY_MAX_ATTEMPTS));
        return next;
      });

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

  const selectRunningCandidates = createRunningReconcileSelector();
  const loadDiscoveryMetadata = createDiscoveryMetadataLoader(
    (id) => state().children[id] ?? api.state.session.get(id),
    async (id) => (await safeReadAsync(() => api.client.session.get({
      sessionID: id, directory: api.state.path.directory,
    })))?.data,
  );
  const reconcileRunningChildren = async (): Promise<void> => {
    if (reconcileInFlight || disposed) return;
    reconcileInFlight = true;
    lastRunningReconcileAtMs = Date.now();

    try {
      const snapshot = cloneState(state());
      const nowMs = Date.now();
      const currentSessionID = resolveRouteSessionID(api);
      const directory = api.state.path.directory;

      const excludedTargetIDs = new Set<string>();
      for (const [id, backoff] of runningReconcileBackoff) {
        if (shouldSkipCandidateForBackoff(backoff, nowMs)) excludedTargetIDs.add(id);
      }
      let directoryStatus: Promise<{ data?: unknown } | undefined> | undefined;
      const readDirectoryStatus = () => directoryStatus ??= safeReadAsync(() =>
        api.client.session.status({ directory }),
      );

      const selected = selectRunningCandidates({
        children: Object.values(snapshot.children),
        currentSessionID,
        nowMs,
        maxCandidates: RUNNING_RECONCILE_MAX_CANDIDATES,
        excludedTargetIDs,
        oldCandidateAgeMs: RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS,
      });
      const hasTerminalSessions = Object.values(snapshot.children).some(
        (child) => child.id.startsWith("ses_") && child.status !== "running",
      );
      const statusSnapshot = hasTerminalSessions || currentSessionID !== undefined || selected.some((candidate) => candidate.targetSessionID !== undefined)
        ? asRecord((await readDirectoryStatus())?.data)
        : undefined;
      if (disposed || pendingEvents.length > 0) return;

      const mutations: Array<{
        childID: string;
        targetSessionID: string;
        status: "done" | "error";
        endedAt?: string;
        reconcileWithoutTargetSessionID?: boolean;
      }> = [];

      const parentAnalysisCache = new Map<
        string,
        PersistedParentMessageAnalysis | null
      >();

      for (const candidate of selected) {
        const key = candidate.targetSessionID ?? candidate.childID;
        const cache = runningReconcileBackoff.get(key);
        if (shouldSkipCandidateForBackoff(cache, nowMs)) continue;

        if (!candidate.targetSessionID) {
          if (
            candidate.source !== "subtask" ||
            candidate.parentID.length === 0 ||
            !candidate.messageID
          ) {
            continue;
          }

          const parentSessionID = candidate.parentID;
          let parentAnalysis = parentAnalysisCache.get(parentSessionID);
          if (parentAnalysis === undefined) {
            const parentMessagesResp = await safeReadAsync(() =>
              api.client.session.messages({
                sessionID: parentSessionID,
                directory,
              }),
            );
            parentAnalysis = Array.isArray(parentMessagesResp?.data)
              ? analyzePersistedParentMessages(parentMessagesResp.data)
              : null;
            parentAnalysisCache.set(parentSessionID, parentAnalysis);
          }
          if (parentAnalysis === null) {
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

          const evidence = resolvePersistedStaleSubtaskFromParentAnalysis({
            candidate: {
              childID: candidate.childID,
              parentID: candidate.parentID,
              messageID: candidate.messageID,
              title: candidate.title,
              summary: candidate.summary,
              agentName: candidate.agentName,
            } satisfies PersistedStaleSubtaskCandidate,
            analysis: parentAnalysis,
          });
          if (!evidence) {
            const canSafelyFallbackByParentInactivity =
              canSafelyCloseNoTargetPersistedCandidate({
                nowMs,
                staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
                startedMs: candidate.startedMs,
                updatedMs: candidate.updatedMs,
                latestMessageActivityAtMs:
                  parentAnalysis.summary.latestMessageActivityAtMs,
              });
            if (canSafelyFallbackByParentInactivity) {
              mutations.push({
                childID: candidate.childID,
                targetSessionID: candidate.childID,
                status: "done",
                endedAt:
                  parentAnalysis.summary.latestMessageActivityAt ??
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
            childID: candidate.childID,
            targetSessionID: evidence.targetSessionID ?? candidate.childID,
            status: evidence.status,
            endedAt: evidence.endedAt,
            reconcileWithoutTargetSessionID: true,
          });
          runningReconcileBackoff.delete(key);
          continue;
        }

        const evidence = await probeRunningEvidence({
          api,
          targetSessionID: candidate.targetSessionID,
          directory,
          candidateAgeMs: Math.max(candidate.startedMs, candidate.updatedMs),
          nowMs,
          readDirectoryStatus,
          statusOverride: statusSnapshot === undefined ? undefined
            : Object.hasOwn(statusSnapshot, candidate.targetSessionID) ? statusSnapshot[candidate.targetSessionID]
            : snapshot.children[candidate.targetSessionID] ? { type: "idle" } : undefined,
        });

        if (evidence.status === "done" || evidence.status === "error") {
          mutations.push({
            childID: candidate.childID,
            targetSessionID: candidate.targetSessionID,
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
            childID: candidate.childID,
            targetSessionID: candidate.targetSessionID,
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

      const statuses = statusSnapshot ?? {};
      if (disposed || pendingEvents.length > 0) return;
      if (mutations.length === 0 && Object.keys(statuses).length === 0) return;

      const metadata = currentSessionID === undefined ? new Map<string, Record<string, unknown>>()
        : await loadDiscoveryMetadata(
          Object.keys(statuses).filter((id) => deriveSessionChildStatus(statuses[id]) === "running"),
          new Set([currentSessionID, ...descendantIDsFromChildren(Object.values(snapshot.children), currentSessionID)]),
          () => !disposed && currentSessionID === resolveRouteSessionID(api),
        );
      if (disposed || pendingEvents.length > 0) return;

      snapshotSidebarScrollOffsets();
      setState((current: StatuslineState) => {
        const next = cloneState(current);
        let changed = false;

        const isFresh = (id: string): boolean => {
          const observed = snapshot.children[id];
          const latest = current.children[id];
          return !!observed && !!latest && latest.status === observed.status &&
            latest.updatedAt === observed.updatedAt && latest.endedAt === observed.endedAt &&
            latest.parentID === observed.parentID && latest.targetSessionID === observed.targetSessionID &&
            latest.messageID === observed.messageID && latest.startedAt === observed.startedAt &&
            latest.title === observed.title && latest.summary === observed.summary &&
            latest.agentName === observed.agentName && latest.source === observed.source &&
            latest.toolName === observed.toolName &&
            latest.model?.providerID === observed.model?.providerID &&
            latest.model?.modelID === observed.model?.modelID &&
            latest.model?.variant === observed.model?.variant &&
            latest.tokens?.input === observed.tokens?.input && latest.tokens?.output === observed.tokens?.output &&
            latest.tokens?.total === observed.tokens?.total && latest.tokens?.contextPercent === observed.tokens?.contextPercent;
        };
        let completionIndex: ReturnType<typeof createEventChildIndex> | undefined;
        for (const mutation of mutations) {
          if (current.children[mutation.childID]?.status !== "running" || !isFresh(mutation.childID)) continue;
          completionIndex ??= createEventChildIndex(Object.values(next.children));
          if (
            mutation.reconcileWithoutTargetSessionID &&
            mutation.targetSessionID.startsWith("ses_")
          ) {
            changed =
              upsertChildDetails(next, mutation.childID, {
                targetSessionID: mutation.targetSessionID,
                updatedAt: mutation.endedAt,
              }) || changed;
            const updated = next.children[mutation.childID];
            if (updated) completionIndex.upsert(updated);
          }
          const completionID = mutation.reconcileWithoutTargetSessionID
            ? mutation.childID : mutation.targetSessionID;
          const candidateIDs = completionIndex.matchingIDs(completionID).filter(isFresh);
          if (
            markChildStatus(
              next,
              completionID,
              mutation.status,
              mutation.endedAt,
              candidateIDs,
            )
          ) {
            changed = true;
          }
        }

        changed = resumeKnownBusySessions(next, snapshot, statuses) || changed;
        if (currentSessionID === resolveRouteSessionID(api)) {
          changed = discoverCachedBusyDescendants(
            next, currentSessionID, statuses, (id) => metadata.get(id), statusSnapshot !== undefined,
          ) || changed;
        }
        const refreshed = refreshLiveState(next);
        if (!changed && !refreshed) return current;
        return next;
      });
    } finally {
      reconcileInFlight = false;
    }
  };

  let pendingEvents: unknown[] = [];
  const flushEvents = (): void => {
    if (disposed || pendingEvents.length === 0) return;
    const events = pendingEvents;
    pendingEvents = [];
    snapshotSidebarScrollOffsets();
    setState((current: StatuslineState) => {
      const next = cloneState(current);
      const index = createEventChildIndex(Object.values(next.children));
      let changed = false;
      for (const event of events) {
        changed = applySubagentEvent(next, event, index) || changed;
      }
      const refreshed = refreshLiveState(next);
      return changed || refreshed ? next : current;
    });
  };

  const timers = createTuiMaintenanceTimers({
    onElapsedTick: () => {
      snapshotSidebarScrollOffsets();
      setNowMs(Date.now());
    },
    onMaintenanceTick: () => {
      flushEvents();
      const currentNowMs = Date.now();
      if (
        currentNowMs - lastRunningReconcileAtMs >=
        RUNNING_RECONCILE_MAINTENANCE_INTERVAL_MS
      ) {
        void reconcileRunningChildren();
      }

      setState((current: StatuslineState) => {
        const next = runTuiStateMaintenance(api, current);
        if (next === current) return current;
        snapshotSidebarScrollOffsets();
        return next;
      });
    },
  });

  createEffect(() => {
    timers.syncElapsedTimer(
      Object.values(state().children).some((child) => child.status === "running"),
    );
  });

  const applyEvent = (event: unknown): void => {
    if (disposed) return;
    pendingEvents.push(event);
    if (pendingEvents.length >= 1024) flushEvents();
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

  api.lifecycle.onDispose(() => {
    disposed = true;
    pendingEvents = [];
    timers.dispose();
    for (const timeout of hydrateRetryTimeouts.values()) {
      clearTimeout(timeout);
    }
    hydrateRetryTimeouts.clear();
    commandDispose();
    for (const dispose of disposers) {
      dispose();
    }
    disposeRoot();
  });

  api.slots.register({
    order: 90,
    slots: {
      sidebar_content(ctx: SidebarContentContext) {
        const routeSessionID = resolveRouteSessionID(api);
        const sessionID = ctx.session_id ?? routeSessionID ?? "";
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

const plugin: TuiPluginModule = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
