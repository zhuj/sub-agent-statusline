import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import type { StatuslineState } from "./state.js";
import { applySubagentEventDetailed } from "./events.js";
import { createPersistenceCoordinator } from "./persistence.js";
import { renderStatusLine } from "./render.js";
import {
  createEmptyState,
  gcStaleInstanceDirs,
  loadState,
  resolveStatePath,
  resolveTextPath,
  saveState,
  saveStatusText,
  shouldPreserveStateOnStartup,
} from "./state.js";

function runtimeDebugLog(entry: Record<string, unknown>): void {
  if (!process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS) return;
  try {
    const path = join(
      process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
      "opencode-subagent-statusline",
      "runtime-events.log",
    );
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    appendFileSync(path, `${line}\n`, "utf8");
  } catch {
    // Debug logging must never crash the runtime plugin.
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
  const persistence = createPersistenceCoordinator<StatuslineState>(async (snapshot) => {
    await saveState(statePath, snapshot);
    await saveStatusText(textPath, renderStatusLine(snapshot));
  });

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

  let eventTransaction = Promise.resolve();

  return {
    event: async ({ event }: { event?: unknown }) => {
      const transaction = eventTransaction.then(async () => {
        try {
          const state = await loadState(statePath);
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
