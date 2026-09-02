import type { Plugin } from "@opencode-ai/plugin";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import os from "node:os";
import type { StatuslineState } from "./state.js";
import { applySubagentEventDetailed } from "./events.js";
import { createPersistenceCoordinator } from "./persistence.js";
import { renderStatusLine } from "./render.js";
import {
  createEmptyState,
  CHANGED_CHILD_IDS,
  gcStaleInstanceDirs,
  loadState,
  resolveStatePath,
  resolveTextPath,
  saveState,
  saveStatusText,
  shouldPreserveStateOnStartup,
} from "./state.js";

// Debug logging is asynchronous + coalesced: writes are queued on a microtask
// debounce so the runtime plugin's hot path never blocks on sync I/O and bursts
// collapse to a small number of flushes.
const RUNTIME_DEBUG_FLUSH_MS = 250;
const runtimeDebugBuffer: string[] = [];
let runtimeDebugFlushHandle: ReturnType<typeof setTimeout> | undefined;
let runtimeDebugPathResolved: string | undefined;

async function flushRuntimeDebugBuffer(): Promise<void> {
  runtimeDebugFlushHandle = undefined;
  if (runtimeDebugBuffer.length === 0) return;
  const lines = runtimeDebugBuffer.splice(0, runtimeDebugBuffer.length).join("");
  try {
    if (runtimeDebugPathResolved === undefined) {
      const path = join(
        process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
        "opencode-subagent-statusline",
        "runtime-events.log",
      );
      await mkdir(dirname(path), { recursive: true });
      runtimeDebugPathResolved = path;
    }
    await appendFile(runtimeDebugPathResolved, lines, "utf8");
  } catch {
    // Debug logging must never crash the runtime plugin.
  }
}

function runtimeDebugLog(entry: Record<string, unknown>): void {
  if (!process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS) return;
  const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
  runtimeDebugBuffer.push(line);
  if (runtimeDebugFlushHandle === undefined) {
    runtimeDebugFlushHandle = setTimeout(() => {
      void flushRuntimeDebugBuffer();
    }, RUNTIME_DEBUG_FLUSH_MS);
  }
}

export const SubagentStatusline: Plugin = async () => {
  // Best-effort cleanup of stale `pid-*` instance directories from previous
  // OpenCode runs. Runs once at boot; never blocks startup on failure.
  void gcStaleInstanceDirs()
    .then((removed) => {
      if (removed > 0) {
        runtimeDebugLog({ kind: "runtime.gc.stale-instance-dirs", removed });
      }
    })
    .catch(() => undefined);

  const statePath = resolveStatePath();
  const textPath = resolveTextPath(statePath);
  let lastStatusText = "";
  const persistence = createPersistenceCoordinator<StatuslineState>(
    async (snapshot) => {
      await saveState(statePath, snapshot);
      const nextText = renderStatusLine(snapshot);
      // Skip the status.txt write when the rendered summary is byte-identical
      // to the last persisted snapshot — most event bursts only change child
      // details that don't affect the aggregate text.
      if (nextText !== lastStatusText) {
        lastStatusText = nextText;
        await saveStatusText(textPath, nextText);
      }
    },
  );

  if (!shouldPreserveStateOnStartup()) {
    try {
      const emptyState = createEmptyState();
      await persistence.flush(emptyState);
    } catch {
      // Defensive by design: initialization failure should not crash OpenCode startup.
    }
  } else {
    runtimeDebugLog({ kind: "runtime.startup.preserve" });
  }

  // Cache the loaded state across events so we don't re-read+parse state.json
  // on every event. The on-disk file is only consulted once at startup and
  // whenever the in-memory cache is invalidated by an external write.
  let cachedState: StatuslineState | undefined;
  let eventTransaction = Promise.resolve();

  const getOrLoadState = async (): Promise<StatuslineState> => {
    if (cachedState !== undefined) return cachedState;
    const loaded = await loadState(statePath);
    cachedState = loaded;
    return loaded;
  };

  return {
    event: async ({ event }: { event?: unknown }) => {
      const transaction = eventTransaction.then(async () => {
        try {
          const state = await getOrLoadState();
          const transactionResult = applySubagentEventDetailed(state, event);

          if (transactionResult.changed) {
            const terminal =
              transactionResult.mutationCategories.includes("status") &&
              transactionResult.changedChildIDs.some((childID) => {
                const child = state.children[childID];
                return child?.status === "done" || child?.status === "error";
              });
            runtimeDebugLog({
              kind: "runtime.event.applied",
              terminal,
              changedChildIDs: transactionResult.changedChildIDs.length,
              categories: transactionResult.mutationCategories,
            });
            // Attach the changed IDs to the snapshot so saveState can do a
            // differential refresh. The Symbol key is invisible to JSON.
            (state as unknown as Record<symbol, unknown>)[CHANGED_CHILD_IDS] =
              transactionResult.changedChildIDs;
            const write = terminal
              ? persistence.flush(state)
              : persistence.request(state);
            await write;
          }
        } catch (error) {
          runtimeDebugLog({
            kind: "runtime.event.error",
            message: error instanceof Error ? error.message : "unknown",
          });
          // Defensive by design: plugin should never crash OpenCode on bad event shape.
          // Drop the cache so the next event re-reads from disk in case state
          // has been corrupted in memory by a bad event.
          cachedState = undefined;
        }
      });
      eventTransaction = transaction.then(
        () => undefined,
        () => undefined,
      );
      await transaction;
    },
  };
};
