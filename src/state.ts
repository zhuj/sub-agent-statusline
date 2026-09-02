import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import os from "node:os";
import {
  classifySubagentWorkItem,
  correlateSubagentWorkItems,
} from "./subagent-classification.js";
import { buildSubagentProjection, buildSubagentProjectionFromChildren } from "./projection.js";

export type ChildStatus = "running" | "done" | "error";

/**
 * Per-child token usage snapshot. Every field is optional; a fully-undefined
 * snapshot represents "no token evidence available" and is intentionally
 * distinct from `{ total: 0 }`.
 *
 * Merging rules (see {@link mergeTokens}): an incoming field replaces the
 * existing field only when defined. Empty/wholly-undefined merges should
 * collapse to `undefined` so callers can skip no-op state writes.
 *
 * Equality rules (see {@link sameTokens}): structural equality via JSON
 * serialization; suitable for sparse field sets but NOT for big-integer
 * precision loss — keep token totals within `Number.MAX_SAFE_INTEGER`.
 */
export interface ChildTokenState {
  /** Prompt/input tokens consumed by the child so far. */
  input?: number;
  /** Completion/output tokens consumed by the child so far. */
  output?: number;
  /** Combined total (input + output). Some upstream sources only emit `total`. */
  total?: number;
  /** Context-window usage percent (0–100) when reported. */
  contextPercent?: number;
}

export interface ChildModelState {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface ChildSessionState {
  id: string;
  title: string;
  summary?: string;
  agentName?: string;
  parentID: string;
  messageID?: string;
  source?: "session" | "subtask" | "tool";
  toolName?: string;
  targetSessionID?: string;
  status: ChildStatus;
  color: "yellow" | "green" | "red";
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  elapsedMs?: number;
  tokens?: ChildTokenState;
  model?: ChildModelState;
}

export interface StatuslineState {
  children: Record<string, ChildSessionState>;
  countedChildIDs: Record<string, true>;
  totalExecuted: number;
  updatedAt: string;
}

export interface StatusCounts {
  running: number;
  done: number;
  error: number;
}

const TERMINAL_CHILD_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_TERMINAL_CHILDREN = 1_500;

function statusColor(status: ChildStatus): ChildSessionState["color"] {
  if (status === "done") return "green";
  if (status === "error") return "red";
  return "yellow";
}

/**
 * Parses a string-or-number timestamp into an ISO 8601 string. Strings are
 * parsed via `Date.parse` (accepts ISO 8601 and the formats Node's `Date`
 * understands). Numbers are interpreted as seconds when below 10_000_000_000
 * (the epoch-ms-vs-seconds ambiguity cutoff) and as milliseconds otherwise.
 *
 * Returns `undefined` when the input is empty, non-finite, or unparseable.
 * Exported so events.ts and any future caller share the same parsing rules.
 */
export function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (value.trim().length === 0) return undefined;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return undefined;
    return new Date(parsed).toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return undefined;
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  return undefined;
}

function safeTimestamp(input: unknown, fallback: string): string {
  if (typeof input !== "string") return fallback;
  if (input.length === 0) return fallback;
  return Number.isNaN(Date.parse(input)) ? fallback : input;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  const parsed = toFiniteNumber(value);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function sanitizeCountedChildIDs(input: unknown): Record<string, true> {
  if (!input || typeof input !== "object") return {};

  const counted: Record<string, true> = {};
  for (const [id, value] of Object.entries(input)) {
    if (!id) continue;
    if (value === true) {
      counted[id] = true;
    }
  }
  return counted;
}

function normalizeExecutionCounters(state: StatuslineState): void {
  state.countedChildIDs = sanitizeCountedChildIDs(state.countedChildIDs);
  const countedTotal = Object.keys(state.countedChildIDs).length;
  state.totalExecuted = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    countedTotal,
  );
}

type CountableChildInput = Pick<
  ChildSessionState,
  "id" | "title" | "parentID"
> &
  Partial<Pick<ChildSessionState, "messageID" | "source" | "targetSessionID">>;

function resolveExecutionCountIdentity(
  child: CountableChildInput,
): string | undefined {
  const classification = classifySubagentWorkItem(child);
  return classification.kind === "real-execution"
    ? classification.executionID
    : undefined;
}

export function isVisibleSubagentCounterEligible(
  child: ChildSessionState,
): boolean {
  return classifySubagentWorkItem(child).kind === "real-execution";
}

export function countHistoricalSubagentExecutions(input: {
  children: Record<string, ChildSessionState> | ChildSessionState[];
  parentSessionID?: string;
}): number {
  const projection = buildSubagentProjectionFromChildren(
    Array.isArray(input.children)
      ? input.children
      : Object.values(input.children),
  );
  const scopedIDs = input.parentSessionID
    ? projection.canonicalRows
        .filter((row) => row.parentID === input.parentSessionID)
        .map((row) => row.targetSessionID ?? row.id)
    : projection.orderedExecutionIDs;
  return new Set(scopedIDs).size;
}

export function countCountedSubagentExecutions(input: {
  children: Record<string, ChildSessionState> | ChildSessionState[];
  countedChildIDs: Record<string, true>;
  parentSessionID?: string;
}): number {
  const projection = buildSubagentProjectionFromChildren(
    Array.isArray(input.children)
      ? input.children
      : Object.values(input.children),
  );
  const scopedExecutionIDs = input.parentSessionID
    ? projection.canonicalRows
        .filter((row) => row.parentID === input.parentSessionID)
        .map((row) => row.targetSessionID ?? row.id)
    : projection.orderedExecutionIDs;
  return scopedExecutionIDs.filter(
    (id) => input.countedChildIDs[id],
  ).length;
}

export function countRetainedSubagentStatuses(input: {
  children: Record<string, ChildSessionState> | ChildSessionState[];
  parentSessionID?: string;
}): StatusCounts {
  const projection = buildSubagentProjectionFromChildren(
    Array.isArray(input.children)
      ? input.children
      : Object.values(input.children),
  );
  const scopedRows = input.parentSessionID
    ? projection.canonicalRows.filter(
        (row) => row.parentID === input.parentSessionID,
      )
    : projection.canonicalRows;
  const counts: StatusCounts = { running: 0, done: 0, error: 0 };
  for (const row of scopedRows) {
    if (row.status === "running") counts.running += 1;
    else if (row.status === "done") counts.done += 1;
    else if (row.status === "error") counts.error += 1;
  }
  return counts;
}

// Per-state fingerprint of the last execution-identity reconcile, used to
// skip rebuilds when nothing has changed since the previous call. Keyed by
// the state object so each loaded state has its own cache.
const reconcileFingerprints = new WeakMap<StatuslineState, string>();

function reconcileCountedExecutionsWithChildren(state: StatuslineState): void {
  const projection = buildSubagentProjection(state);
  const fingerprint = projection.orderedExecutionIDs.join("|");
  if (reconcileFingerprints.get(state) === fingerprint) return;
  reconcileFingerprints.set(state, fingerprint);

  state.countedChildIDs = Object.fromEntries(
    projection.orderedExecutionIDs.map((id) => [id, true]),
  ) as Record<string, true>;
  state.totalExecuted = projection.totalExecuted;
}

function countChildExecution(
  state: StatuslineState,
  child: CountableChildInput,
): boolean {
  normalizeExecutionCounters(state);
  const countIdentity = resolveExecutionCountIdentity(child);
  if (!countIdentity) return false;
  if (state.countedChildIDs[countIdentity]) return false;

  const previousTotal = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    Object.keys(state.countedChildIDs).length,
  );
  state.countedChildIDs[countIdentity] = true;
  state.totalExecuted = previousTotal + 1;
  return true;
}

function sanitizeTokens(input: unknown): ChildTokenState | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const tokens: ChildTokenState = {
    input: toFiniteNumber(raw.input),
    output: toFiniteNumber(raw.output),
    total: toFiniteNumber(raw.total),
    contextPercent: toFiniteNumber(raw.contextPercent),
  };

  if (
    tokens.input === undefined &&
    tokens.output === undefined &&
    tokens.total === undefined &&
    tokens.contextPercent === undefined
  ) {
    return undefined;
  }

  return tokens;
}

function sanitizeModel(input: unknown): ChildModelState | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const providerID =
    typeof raw.providerID === "string" ? raw.providerID.trim() : "";
  const modelID = typeof raw.modelID === "string" ? raw.modelID.trim() : "";
  const variant = typeof raw.variant === "string" ? raw.variant.trim() : "";
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

function sanitizeTargetSessionID(
  value: unknown,
  fallback?: string,
): string | undefined {
  if (typeof value === "string" && value.startsWith("ses_")) {
    return value;
  }
  if (typeof fallback === "string" && fallback.startsWith("ses_")) {
    return fallback;
  }
  return undefined;
}

/**
 * Merges two token snapshots, preferring `incoming` fields when defined.
 * Used by both state.ts mutators and downstream callers (tui.tsx) so the
 * merge policy lives in a single place.
 */
export function mergeTokens(
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

/**
 * Returns true when both token snapshots are deeply equal. Defined in
 * state.ts so all consumers (state.ts, tui.tsx) compare identically.
 */
export function sameTokens(
  left: ChildTokenState | undefined,
  right: ChildTokenState | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function sanitizeSummary(value: unknown, title: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value.replace(/\s+/g, " ").trim();
  if (!summary) return undefined;
  if (normalizeComparableText(summary) === normalizeComparableText(title)) {
    return undefined;
  }
  return summary;
}

function sanitizeAgentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const agentName = value
    .replace(/^\((.*)\)$/, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return agentName || undefined;
}

function resolveElapsedMs(child: ChildSessionState, nowMs: number): number {
  const startedMs = Date.parse(child.startedAt);
  if (Number.isNaN(startedMs)) return 0;

  const endSource = child.endedAt ?? child.updatedAt;
  const endMs = child.endedAt ? Date.parse(endSource) : nowMs;
  if (Number.isNaN(endMs)) return 0;
  return Math.max(0, endMs - startedMs);
}

function terminalReferenceMs(child: ChildSessionState): number {
  const parsed = Date.parse(
    child.endedAt ?? child.updatedAt ?? child.startedAt,
  );
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function pruneTerminalChildren(
  state: StatuslineState,
  now = new Date(),
): number {
  const nowMs = now.getTime();
  const terminalChildren: Array<{ id: string; referenceMs: number }> = [];
  let pruned = 0;

  for (const child of Object.values(state.children)) {
    if (child.status === "running") continue;

    const referenceMs = terminalReferenceMs(child);
    if (nowMs - referenceMs > TERMINAL_CHILD_TTL_MS) {
      delete state.children[child.id];
      pruned += 1;
      continue;
    }

    terminalChildren.push({ id: child.id, referenceMs });
  }

  if (terminalChildren.length <= MAX_TERMINAL_CHILDREN) {
    return pruned;
  }

  terminalChildren.sort(
    (a, b) => b.referenceMs - a.referenceMs || a.id.localeCompare(b.id),
  );
  for (const child of terminalChildren.slice(MAX_TERMINAL_CHILDREN)) {
    delete state.children[child.id];
    pruned += 1;
  }

  return pruned;
}

export function isTerminalPruningDue(
  state: StatuslineState,
  now = new Date(),
): boolean {
  return isTerminalPruningDueAt(state, now.getTime());
}

// Avoids allocating a `new Date(nowMs)` wrapper in the hot 2-second
// maintenance tick path. Mirrors the semantics of `isTerminalPruningDue` but
// takes a millisecond timestamp directly.
export function isTerminalPruningDueAt(
  state: StatuslineState,
  nowMs: number,
): boolean {
  const children = state.children;
  let retainedTerminalChildren = 0;

  // Iterate keys directly to avoid allocating an Object.values array each call.
  for (const id in children) {
    const child = children[id];
    if (!child) continue;
    if (child.status === "running") continue;
    if (nowMs - terminalReferenceMs(child) > TERMINAL_CHILD_TTL_MS) {
      return true;
    }
    retainedTerminalChildren += 1;
    if (retainedTerminalChildren > MAX_TERMINAL_CHILDREN) return true;
  }

  return false;
}

function refreshChildFields(
  state: StatuslineState,
  id: string,
  child: ChildSessionState,
  nowISO: string,
  nowMs: number,
): void {
  const startedAt = safeTimestamp(child.startedAt, nowISO);
  const updatedAt = safeTimestamp(child.updatedAt, nowISO);
  const endedAt = child.endedAt
    ? safeTimestamp(child.endedAt, updatedAt)
    : undefined;
  const status =
    child.status === "done" ||
    child.status === "error" ||
    child.status === "running"
      ? child.status
      : "running";

  const targetSessionID = sanitizeTargetSessionID(
    child.targetSessionID,
    id.startsWith("ses_") ? id : undefined,
  );

  state.children[id] = {
    ...child,
    startedAt,
    updatedAt,
    endedAt,
    status,
    targetSessionID,
    color: statusColor(status),
    tokens: sanitizeTokens(child.tokens),
    model: sanitizeModel(child.model),
    elapsedMs: resolveElapsedMs(
      {
        ...child,
        startedAt,
        updatedAt,
        endedAt,
        status,
        color: statusColor(status),
      },
      nowMs,
    ),
  };
}

export function refreshDerivedFields(
  state: StatuslineState,
  now = new Date(),
  onPrune?: (prunedCount: number, nowISO: string) => void,
): void {
  const nowISO = now.toISOString();
  const nowMs = now.getTime();

  normalizeExecutionCounters(state);

  for (const [id, child] of Object.entries(state.children)) {
    refreshChildFields(state, id, child, nowISO, nowMs);
  }

  reconcileCountedExecutionsWithChildren(state);
  state.updatedAt = safeTimestamp(state.updatedAt, nowISO);
  const pruned = pruneTerminalChildren(state, now);
  if (pruned > 0) {
    reconcileCountedExecutionsWithChildren(state);
    state.updatedAt = nowISO;
    onPrune?.(pruned, nowISO);
  }
}

const STATUS_DIRNAME = "opencode-subagent-statusline";
const STATUS_FILENAME = "state.json";
const STATUS_DIR_MODE = 0o700;
const STATUS_FILE_MODE = 0o600;

function sanitizeInstanceName(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, "_");
}

function resolveDefaultInstanceName(): string {
  const fromEnv = process.env.OPENCODE_SUBAGENT_STATUSLINE_INSTANCE;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    const safe = sanitizeInstanceName(fromEnv);
    if (safe.length > 0) {
      return safe;
    }
  }

  return `pid-${process.pid}`;
}

export function shouldPreserveStateOnStartup(): boolean {
  return process.env.OPENCODE_SUBAGENT_STATUSLINE_PRESERVE_STATE === "1";
}

export function createEmptyState(): StatuslineState {
  return {
    children: {},
    countedChildIDs: {},
    totalExecuted: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function resolveStatePath(): string {
  const fromEnv = process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv;
  }

  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  const instance = resolveDefaultInstanceName();
  return join(runtimeDir, STATUS_DIRNAME, instance, STATUS_FILENAME);
}

export function resolveTextPath(statePath: string): string {
  return join(dirname(statePath), "status.txt");
}

const STALE_INSTANCE_DIR_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Removes stale `pid-*` instance directories under the runtime base dir whose
 * last-modified time is older than `STALE_INSTANCE_DIR_TTL_MS`. Best-effort:
 * any per-entry error is swallowed because directory cleanup must never
 * crash the plugin. Only runs when no `OPENCODE_SUBAGENT_STATUSLINE_STATE`
 * override is set, since overrides point outside the directory tree we own.
 *
 * Returns the number of directories successfully removed (0 when no GC was
 * needed or attempted).
 */
export async function gcStaleInstanceDirs(
  ttlMs: number = STALE_INSTANCE_DIR_TTL_MS,
): Promise<number> {
  if (
    typeof process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE === "string" &&
    process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE.trim().length > 0
  ) {
    return 0;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  const base = join(runtimeDir, STATUS_DIRNAME);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoffMs = Date.now() - ttlMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("pid-")) continue;
    const dir = join(base, entry.name);
    try {
      const dirStat = await stat(dir);
      if (dirStat.mtimeMs >= cutoffMs) continue;
      await rm(dir, { force: true, recursive: true });
      removed += 1;
    } catch {
      // Defensive: never let cleanup errors escape.
    }
  }
  return removed;
}

export async function loadState(statePath: string): Promise<StatuslineState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StatuslineState>;
    if (!parsed || typeof parsed !== "object") {
      return createEmptyState();
    }

    const children =
      parsed.children && typeof parsed.children === "object"
        ? parsed.children
        : {};
    const countedChildIDs = sanitizeCountedChildIDs(parsed.countedChildIDs);

    const state: StatuslineState = {
      children: children as Record<string, ChildSessionState>,
      countedChildIDs,
      totalExecuted: Math.max(
        toNonNegativeInteger(parsed.totalExecuted) ?? 0,
        Object.keys(countedChildIDs).length,
      ),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString(),
    };

    for (const [id, child] of Object.entries(children)) {
      const candidate = child as Partial<ChildSessionState>;
      if (
        typeof candidate.title !== "string" ||
        typeof candidate.parentID !== "string"
      ) {
        continue;
      }
      const targetSessionID = sanitizeTargetSessionID(
        candidate.targetSessionID,
        id.startsWith("ses_") ? id : undefined,
      );
      const countIdentity = resolveExecutionCountIdentity({
        id,
        title: candidate.title,
        parentID: candidate.parentID,
        messageID: candidate.messageID,
        source: candidate.source,
        targetSessionID,
      });
      if (countIdentity) {
        state.countedChildIDs[countIdentity] = true;
      }
    }

    reconcileCountedExecutionsWithChildren(state);
    refreshDerivedFields(state);
    return state;
  } catch {
    return createEmptyState();
  }
}

async function writeLocalStatusFile(
  path: string,
  contents: string,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: STATUS_DIR_MODE });

  const tempPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempPath, contents, {
      encoding: "utf8",
      mode: STATUS_FILE_MODE,
    });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Non-enumerable symbol used by the runtime plugin to thread the list of
 * child IDs that changed in this event round-trip through to `saveState`,
 * so the differential refresh can skip re-deriving fields for the other
 * children. Hidden from JSON.stringify because Symbol keys are skipped.
 */
export const CHANGED_CHILD_IDS = Symbol.for(
  "opencode-subagent-statusline.changedChildIDs",
);

export async function saveStatusText(
  textPath: string,
  contents: string,
): Promise<void> {
  await writeLocalStatusFile(textPath, contents);
}

export async function saveState(
  statePath: string,
  state: StatuslineState,
  options: { readonly changedChildIDs?: readonly string[] } = {},
): Promise<void> {
  // The caller may have attached CHANGED_CHILD_IDS via the persistence
  // coordinator (Symbol property is invisible to JSON.stringify).
  const changedChildIDs =
    options.changedChildIDs ??
    ((state as unknown as Record<symbol, unknown>)[CHANGED_CHILD_IDS] as
      | readonly string[]
      | undefined);
  refreshStateForSnapshot(state, changedChildIDs);
  // Compact JSON — the file is consumed by `loadState` (machine-only), so we
  // skip the human-readable pretty-print to halve bytes and speed up both
  // serialize and parse on every persistence round-trip.
  await writeLocalStatusFile(statePath, JSON.stringify(state));
}

// Differential refresh: re-derive fields for `changedChildIDs` only (or every
// child when the list is omitted), then run counter reconciliation + pruning
// which always need the full state view. Skips the per-child rebuild loop for
// unchanged children, which is the dominant cost on bursty event streams.
export function refreshStateForSnapshot(
  state: StatuslineState,
  changedChildIDs?: readonly string[],
  now: Date = new Date(),
): void {
  const nowISO = now.toISOString();
  const nowMs = now.getTime();
  const children = state.children;

  if (changedChildIDs === undefined) {
    normalizeExecutionCounters(state);
    for (const [id, child] of Object.entries(children)) {
      refreshChildFields(state, id, child, nowISO, nowMs);
    }
  } else {
    // Counter normalization is only relevant if a counted child changed.
    let countersDirty = false;
    for (const id of changedChildIDs) {
      const child = children[id];
      if (!child) continue;
      refreshChildFields(state, id, child, nowISO, nowMs);
      countersDirty = true;
    }
    if (countersDirty) normalizeExecutionCounters(state);
  }

  reconcileCountedExecutionsWithChildren(state);
  state.updatedAt = safeTimestamp(state.updatedAt, nowISO);
  const pruned = pruneTerminalChildren(state, now);
  if (pruned > 0) {
    reconcileCountedExecutionsWithChildren(state);
    state.updatedAt = nowISO;
  }
}

export function upsertRunningChild(
  state: StatuslineState,
  input: Pick<ChildSessionState, "id" | "title" | "parentID"> &
    Partial<
      Pick<
        ChildSessionState,
        | "summary"
        | "agentName"
        | "messageID"
        | "source"
        | "toolName"
        | "targetSessionID"
        | "startedAt"
        | "updatedAt"
      >
    >,
): boolean {
  const now = new Date().toISOString();
  const observedUpdatedAt = safeTimestamp(input.updatedAt, now);
  const observedStartedAt = safeTimestamp(input.startedAt, observedUpdatedAt);
  const existing = state.children[input.id];
  const targetSessionID = sanitizeTargetSessionID(
    input.targetSessionID ?? existing?.targetSessionID,
    input.id.startsWith("ses_") ? input.id : undefined,
  );
  const source = input.source ?? existing?.source ?? "session";
  const counted = existing
    ? false
    : countChildExecution(state, {
        id: input.id,
        title: input.title,
        parentID: input.parentID,
        messageID: input.messageID,
        source,
        targetSessionID,
      });
  const shouldKeepCompletedTiming =
    existing?.status === "done" || existing?.status === "error";
  const next: ChildSessionState = {
    id: input.id,
    title: input.title,
    summary:
      sanitizeSummary(input.summary, input.title) ??
      sanitizeSummary(existing?.summary, input.title),
    agentName: sanitizeAgentName(input.agentName) ?? existing?.agentName,
    parentID: input.parentID,
    messageID: input.messageID ?? existing?.messageID,
    source,
    toolName: input.toolName ?? existing?.toolName,
    targetSessionID,
    status: shouldKeepCompletedTiming ? existing.status : "running",
    color: statusColor(shouldKeepCompletedTiming ? existing.status : "running"),
    startedAt: existing?.startedAt ?? observedStartedAt,
    updatedAt: observedUpdatedAt,
    endedAt: shouldKeepCompletedTiming ? existing.endedAt : undefined,
    elapsedMs: existing?.elapsedMs,
    tokens: existing?.tokens,
    model: existing?.model,
  };

  if (
    existing &&
    next.title === existing.title &&
    next.summary === existing.summary &&
    next.agentName === existing.agentName &&
    next.parentID === existing.parentID &&
    next.messageID === existing.messageID &&
    next.source === existing.source &&
    next.toolName === existing.toolName &&
    next.targetSessionID === existing.targetSessionID &&
    next.status === existing.status &&
    next.color === existing.color &&
    next.startedAt === existing.startedAt &&
    next.endedAt === existing.endedAt &&
    sameTokens(next.tokens, existing.tokens) &&
    JSON.stringify(next.model) === JSON.stringify(existing.model)
  ) {
    return counted;
  }

  state.children[input.id] = next;
  state.updatedAt = observedUpdatedAt;
  return true;
}

export function markChildStatus(
  state: StatuslineState,
  childID: string,
  status: Exclude<ChildStatus, "running">,
  endedAt?: string,
  candidateIDs?: readonly string[],
): boolean {
  const now = new Date().toISOString();
  let changed = false;
  let stateUpdatedAt = state.updatedAt;

  const candidates = candidateIDs
    ? candidateIDs
        .map((id) => state.children[id])
        .filter((child): child is ChildSessionState => child !== undefined)
    : Object.values(state.children);
  for (const child of candidates) {
    if (child.id !== childID && child.targetSessionID !== childID) continue;

    const observedEndedAt = endedAt
      ? safeTimestamp(endedAt, now)
      : (child.endedAt ?? now);

    if (
      child.status === status &&
      child.color === statusColor(status) &&
      child.updatedAt === observedEndedAt &&
      child.endedAt === observedEndedAt
    ) {
      continue;
    }

    const nextChild: ChildSessionState = {
      ...child,
      status,
      color: statusColor(status),
      updatedAt: observedEndedAt,
      endedAt: observedEndedAt,
    };
    state.children[child.id] = {
      ...nextChild,
      elapsedMs: resolveElapsedMs(nextChild, Date.now()),
    };
    stateUpdatedAt = observedEndedAt;
    changed = true;
  }

  if (changed) {
    state.updatedAt = stateUpdatedAt;
  }
  return changed;
}

export function upsertChildDetails(
  state: StatuslineState,
  childID: string,
  input: {
    title?: string;
    summary?: string;
    agentName?: string;
    tokens?: ChildTokenState;
    targetSessionID?: string;
    updatedAt?: string;
  },
): boolean {
  const existing = state.children[childID];
  if (!existing) return false;

  const nextTitle =
    typeof input.title === "string" && input.title.trim().length > 0
      ? input.title
      : existing.title;
  const nextSummary =
    sanitizeSummary(input.summary, nextTitle) ??
    sanitizeSummary(existing.summary, nextTitle);
  const nextAgentName =
    sanitizeAgentName(input.agentName) ?? existing.agentName;
  const mergedTokens = mergeTokens(existing.tokens, input.tokens);
  const nextTargetSessionID = sanitizeTargetSessionID(
    input.targetSessionID ?? existing.targetSessionID,
    existing.id.startsWith("ses_") ? existing.id : undefined,
  );

  const detailsChanged =
    nextTitle !== existing.title ||
    nextSummary !== existing.summary ||
    nextAgentName !== existing.agentName ||
    !sameTokens(mergedTokens, existing.tokens) ||
    nextTargetSessionID !== existing.targetSessionID;

  if (!detailsChanged) return false;

  const now = new Date().toISOString();
  const observedUpdatedAt = safeTimestamp(input.updatedAt, now);
  const next: ChildSessionState = {
    ...existing,
    title: nextTitle,
    summary: nextSummary,
    agentName: nextAgentName,
    tokens: mergedTokens,
    targetSessionID: nextTargetSessionID,
    updatedAt: observedUpdatedAt,
  };
  state.children[childID] = next;
  state.updatedAt = observedUpdatedAt;
  return true;
}

export function setChildModel(
  state: StatuslineState,
  sessionID: string,
  model: ChildModelState | undefined,
  updatedAt?: string,
  candidateIDs?: readonly string[],
): boolean {
  const source = candidateIDs
    ? candidateIDs
        .map((id) => state.children[id])
        .filter((child): child is ChildSessionState => child !== undefined)
    : Object.values(state.children);
  const matches = source.filter(
    (child) => child.id === sessionID || child.targetSessionID === sessionID,
  );
  if (matches.length === 0) return false;

  let changed = false;
  const observedUpdatedAt = safeTimestamp(updatedAt, new Date().toISOString());
  for (const child of matches) {
    const sanitized = sanitizeModel(model);
    if (JSON.stringify(child.model) === JSON.stringify(sanitized)) continue;
    state.children[child.id] = { ...child, model: sanitized };
    changed = true;
  }
  if (changed) state.updatedAt = observedUpdatedAt;
  return changed;
}

export function getCounts(state: StatuslineState): StatusCounts {
  const counts: StatusCounts = { running: 0, done: 0, error: 0 };
  for (const child of Object.values(state.children)) {
    if (!isVisibleSubagentCounterEligible(child)) continue;
    if (child.status === "running") counts.running += 1;
    if (child.status === "done") counts.done += 1;
    if (child.status === "error") counts.error += 1;
  }
  return counts;
}
