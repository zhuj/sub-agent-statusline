import { describe, expect, it, vi } from "vitest";
import {
  awaitCurrentRunningReconcileResult,
  buildStaleSubtaskMessageIndex,
  canSafelyCloseNoTargetPersistedCandidate,
  capCandidates,
  defaultStaleRunningThresholdMs,
  deriveOpenCodeSessionStatus,
  hasStructuredErrorEvidence,
  hasRecentMessageActivity,
  nextBackoffState,
  parseStaleRunningThresholdMs,
  resolvePersistedStaleSubtaskFromParentMessages,
  resolveSessionStatusWithMessageSummary,
  shouldApplyStaleRunningFallback,
  shouldSkipCandidateForBackoff,
  sweepRunningReconcileBackoff,
  summarizeSessionMessages,
  type RunningReconcileEvidence,
  type RunningReconcileVersion,
} from "./reconcile.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("OpenCode session status normalization", () => {
  it.each([
    ["idle", "done"],
    ["done", "done"],
    ["completed", "done"],
    ["success", "done"],
    ["succeeded", "done"],
    ["error", "error"],
    ["failed", "error"],
    ["cancelled", "error"],
    ["aborted", "error"],
    ["busy", "running"],
    ["running", "running"],
    ["pending", "running"],
    ["queued", "running"],
    ["in_progress", "running"],
    ["working", "running"],
    ["compacting", "running"],
    ["retry", "running"],
  ] as const)("maps %s to %s", (raw, expected) => {
    expect(deriveOpenCodeSessionStatus(raw)).toBe(expected);
  });

  it("maps object-shaped evidence and leaves unknown values inconclusive", () => {
    expect(deriveOpenCodeSessionStatus({ status: "working" })).toBe("running");
    expect(deriveOpenCodeSessionStatus({ state: "idle" })).toBe("done");
    expect(deriveOpenCodeSessionStatus({ error: { message: "boom" } })).toBe(
      "error",
    );
    expect(deriveOpenCodeSessionStatus({ status: "mystery" })).toBeUndefined();
    expect(deriveOpenCodeSessionStatus(undefined)).toBeUndefined();
  });

  it("lets structured error evidence override idle hydration status", () => {
    expect(
      deriveOpenCodeSessionStatus({
        status: "idle",
        info: { error: { detail: "Unsupported content type" } },
      }),
    ).toBe("error");
  });

  it("keeps running statuses unless the current status object has structured error evidence", () => {
    expect(deriveOpenCodeSessionStatus({ status: "running" })).toBe("running");
    expect(deriveOpenCodeSessionStatus({ status: "retry" })).toBe("running");

    expect(
      deriveOpenCodeSessionStatus({
        status: "running",
        info: { error: { message: "Bad Request" } },
      }),
    ).toBe("error");
  });
});

describe("reconcile fail-closed fallback gating", () => {
  it("does not allow stale fallback when probes fail or are inconclusive", () => {
    const staleThresholdMs = 24 * 60 * 60_000;
    const ages = { startedMs: staleThresholdMs + 1, updatedMs: staleThresholdMs + 1 };

    const probeFailed: RunningReconcileEvidence = {
      probeFailed: true,
      canApplyStaleFallback: false,
    };
    expect(
      shouldApplyStaleRunningFallback({
        staleThresholdMs,
        evidence: probeFailed,
        ...ages,
      }),
    ).toBe(false);

    const inconclusive: RunningReconcileEvidence = {
      probeFailed: false,
      canApplyStaleFallback: false,
    };
    expect(
      shouldApplyStaleRunningFallback({
        staleThresholdMs,
        evidence: inconclusive,
        ...ages,
      }),
    ).toBe(false);
  });
});

describe("recent activity across roles", () => {
  it("treats non-assistant message activity as recent activity", () => {
    const nowMs = Date.now();
    const activityAt = new Date(nowMs - 1_000).toISOString();
    const summary = summarizeSessionMessages([
      { info: { role: "user", time: { updated: activityAt } } },
      { info: { role: "tool", time: { created: activityAt } } },
    ]);

    expect(summary.latestAssistantActivityAtMs).toBeUndefined();
    expect(summary.latestMessageActivityAtMs).toBeDefined();
    expect(
      hasRecentMessageActivity({
        nowMs,
        latestMessageActivityAtMs: summary.latestMessageActivityAtMs,
        staleThresholdMs: 60_000,
      }),
    ).toBe(true);
  });
});

describe("terminal positive evidence", () => {
  it("marks done for assistant completed and error for assistant error", () => {
    const doneAt = new Date().toISOString();
    const doneSummary = summarizeSessionMessages([
      { info: { role: "assistant", time: { completed: doneAt } } },
    ]);
    expect(doneSummary.completedAt).toBe(doneAt);
    expect(doneSummary.hasError).toBe(false);

    const errorAt = new Date(Date.now() + 1_000).toISOString();
    const errorSummary = summarizeSessionMessages([
      { info: { role: "assistant", error: { message: "boom" }, time: { updated: errorAt } } },
    ]);
    expect(errorSummary.hasError).toBe(true);
    expect(errorSummary.evidenceAt).toBe(errorAt);
  });

  it("uses chronological order for out-of-order completion and error evidence", () => {
    const completedAt = "2026-07-17T09:00:00.000Z";
    const errorAt = "2026-07-17T09:01:00.000Z";

    // Given assistant messages arrive newest first.
    const summary = summarizeSessionMessages([
      {
        info: {
          role: "assistant",
          error: { message: "boom" },
          time: { updated: errorAt },
        },
      },
      { info: { role: "assistant", time: { completed: completedAt } } },
    ]);

    // Then the later error remains authoritative over the older completion.
    expect(summary.completedAt).toBe(completedAt);
    expect(summary.evidenceAt).toBe(errorAt);
    expect(summary.hasError).toBe(true);
    expect(summary.latestAssistantActivityAt).toBe(errorAt);
    expect(summary.latestAssistantActivityAtMs).toBe(Date.parse(errorAt));
  });

  it("uses input order to break equal assistant timestamps", () => {
    const timestamp = "2026-07-17T09:00:00.000Z";

    // Given an error is followed by a completion at the same timestamp.
    const summary = summarizeSessionMessages([
      {
        info: {
          role: "assistant",
          error: { message: "transient" },
          time: { updated: timestamp },
        },
      },
      { info: { role: "assistant", time: { completed: timestamp } } },
    ]);

    // Then the later input wins the stable chronological tie.
    expect(summary.completedAt).toBe(timestamp);
    expect(summary.evidenceAt).toBe(timestamp);
    expect(summary.hasError).toBe(false);
    expect(summary.latestAssistantActivityAt).toBe(timestamp);
    expect(summary.latestAssistantActivityAtMs).toBe(Date.parse(timestamp));
  });

  it("lets assistant error evidence override idle or done session status", () => {
    const errorAt = new Date().toISOString();
    const summary = summarizeSessionMessages([
      {
        info: {
          role: "assistant",
          error: { message: "Bad Request", detail: "Unsupported content type" },
          time: { updated: errorAt },
        },
      },
    ]);

    expect(
      resolveSessionStatusWithMessageSummary({
        status: "done",
        summary,
      }),
    ).toEqual({ status: "error", endedAt: errorAt });
  });

  it("preserves running status over older message summary evidence", () => {
    expect(
      resolveSessionStatusWithMessageSummary({
        status: "running",
        summary: { completedAt: "2026-05-10T10:00:00.000Z" },
      }),
    ).toEqual({ status: "running" });

    expect(
      resolveSessionStatusWithMessageSummary({
        status: "running",
        summary: {
          hasError: true,
          evidenceAt: "2026-05-10T10:01:00.000Z",
        },
      }),
    ).toEqual({ status: "running" });
  });

  it("detects structured nested error evidence without matching plain text", () => {
    expect(
      hasStructuredErrorEvidence({
        properties: { info: { error: { detail: "Unsupported content type" } } },
      }),
    ).toBe(true);
    expect(
      hasStructuredErrorEvidence({
        message: "Bad Request: Unsupported content type",
      }),
    ).toBe(false);
  });
});

describe("stale fallback thresholds", () => {
  it("defaults to approximately 10 hours and preserves override semantics", () => {
    expect(defaultStaleRunningThresholdMs()).toBe(10 * 60 * 60_000);
    expect(parseStaleRunningThresholdMs(undefined)).toBe(
      defaultStaleRunningThresholdMs(),
    );
    expect(parseStaleRunningThresholdMs("not-a-number")).toBe(
      defaultStaleRunningThresholdMs(),
    );
    expect(parseStaleRunningThresholdMs("1234.9")).toBe(1234);
    expect(parseStaleRunningThresholdMs("0")).toBe(0);
  });

  it("applies fallback only after threshold and only when probes succeeded", () => {
    const staleThresholdMs = 10_000;
    const succeeded: RunningReconcileEvidence = {
      probeFailed: false,
      canApplyStaleFallback: true,
    };
    expect(
      shouldApplyStaleRunningFallback({
        staleThresholdMs,
        evidence: succeeded,
        startedMs: staleThresholdMs,
        updatedMs: staleThresholdMs,
      }),
    ).toBe(true);

    expect(
      shouldApplyStaleRunningFallback({
        staleThresholdMs,
        evidence: succeeded,
        startedMs: staleThresholdMs - 1,
        updatedMs: staleThresholdMs,
      }),
    ).toBe(false);
  });
});

describe("candidate cap and backoff", () => {
  it("caps candidates and exponentially backs off unresolved probes", () => {
    expect(capCandidates([1, 2, 3, 4], 2)).toEqual([1, 2]);

    const nowMs = Date.now();
    const initial = nextBackoffState({
      cache: undefined,
      nowMs,
      initialBackoffMs: 15_000,
      maxBackoffMs: 300_000,
    });
    expect(initial.backoffMs).toBe(15_000);
    expect(shouldSkipCandidateForBackoff(initial, nowMs + 1)).toBe(true);

    const doubled = nextBackoffState({
      cache: initial,
      nowMs,
      initialBackoffMs: 15_000,
      maxBackoffMs: 300_000,
    });
    expect(doubled.backoffMs).toBe(30_000);
  });

  it("sweeps backoff entries without retained running candidates", () => {
    const backoff = new Map([
      ["ses_running", { backoffMs: 15_000, nextAllowedAtMs: 20_000 }],
      ["ses_terminal", { backoffMs: 30_000, nextAllowedAtMs: 40_000 }],
      ["ses_pruned", { backoffMs: 60_000, nextAllowedAtMs: 80_000 }],
    ]);

    expect(sweepRunningReconcileBackoff(backoff, new Set(["ses_running"]))).toBe(2);
    expect([...backoff.keys()]).toEqual(["ses_running"]);
  });
});

describe("stale running reconciliation results", () => {
  const version = {
    childID: "ses_child",
    targetSessionID: "ses_target",
    parentID: "ses_parent",
    messageID: "msg_child",
    status: "running" as const,
    updatedAt: "2026-07-17T09:00:00.000Z",
  };

  it.each([
    ["newer status", { status: "done" as const }],
    ["newer updatedAt", { updatedAt: "2026-07-17T09:01:00.000Z" }],
    ["changed target", { targetSessionID: "ses_other" }],
    ["changed message", { messageID: "msg_other" }],
  ])("ignores a probe after %s changes", async (_label, change) => {
    const probe = deferred<{ readonly status: "done" }>();
    let current: RunningReconcileVersion = version;
    const persist = vi.fn();
    const pending = awaitCurrentRunningReconcileResult({
      version,
      probe: () => probe.promise,
      isLifecycleValid: () => true,
      currentVersion: () => current,
    });
    current = { ...version, ...change };
    probe.resolve({ status: "done" });

    const result = await pending;
    if (result) persist(result);

    expect(result).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it("ignores a probe after route or lifecycle invalidation", async () => {
    const probe = deferred<{ readonly status: "done" }>();
    let valid = true;
    const persist = vi.fn();
    const pending = awaitCurrentRunningReconcileResult({
      version,
      probe: () => probe.promise,
      isLifecycleValid: () => valid,
      currentVersion: () => version,
    });
    valid = false;
    probe.resolve({ status: "done" });

    const result = await pending;
    if (result) persist(result);

    expect(result).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("persisted stale subtask recovery evidence", () => {
  const stale = {
    childID: "subtask:prt_ddea56110001RtlmRJFV99PmiU",
    parentID: "ses_2215a9f08ffewGBrk9aJ973lCD",
    messageID: "msg_ddea560fd001mnSF0ssrplOLZq",
    title: "Execute subtask",
  };

  it("resolves terminal task evidence from parent assistant message parentID", () => {
    const result = resolvePersistedStaleSubtaskFromParentMessages({
      candidate: stale,
      messages: [
        {
          info: {
            role: "assistant",
            parentID: "msg_ddea560fd001mnSF0ssrplOLZq",
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                metadata: { sessionId: "ses_2215a9eceffelCOOb8v66cT2v0" },
                time: { end: "2026-04-30T12:20:00.000Z" },
              },
            },
          ],
        },
      ],
    });

    expect(result).toEqual({
      status: "done",
      targetSessionID: "ses_2215a9eceffelCOOb8v66cT2v0",
      endedAt: "2026-04-30T12:20:00.000Z",
    });
  });

  it("fails closed when evidence is ambiguous", () => {
    const result = resolvePersistedStaleSubtaskFromParentMessages({
      candidate: stale,
      messages: [
        {
          info: {
            role: "assistant",
            parentID: "msg_ddea560fd001mnSF0ssrplOLZq",
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                metadata: { sessionId: "ses_1" },
              },
            },
            {
              type: "tool",
              tool: "task",
              state: {
                status: "error",
                output: "task_id: ses_2",
              },
            },
          ],
        },
      ],
    });

    expect(result).toBeUndefined();
  });

  it("selects a unique highest-score stale match regardless of input order", () => {
    const result = resolvePersistedStaleSubtaskFromParentMessages({
      candidate: {
        ...stale,
        summary: "Run auth migration",
        agentName: "code",
      },
      messages: [
        {
          info: { role: "assistant", parentID: "msg_unrelated" },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { prompt: "Run auth migration" },
                metadata: { sessionId: "ses_lower_score" },
              },
            },
          ],
        },
        {
          info: {
            role: "assistant",
            parentID: "msg_ddea560fd001mnSF0ssrplOLZq",
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "error",
                output: "task_id: ses_best_score",
              },
            },
          ],
        },
      ],
    });

    expect(result).toEqual({
      status: "error",
      endedAt: undefined,
      targetSessionID: "ses_best_score",
    });
  });

  it("fails closed when the highest stale-match score is tied", () => {
    const result = resolvePersistedStaleSubtaskFromParentMessages({
      candidate: {
        ...stale,
        summary: "Run auth migration",
      },
      messages: [
        {
          info: { role: "assistant", parentID: "msg_unrelated" },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { prompt: "Run auth migration" },
                metadata: { sessionId: "ses_lower_score" },
              },
            },
          ],
        },
        {
          info: {
            role: "assistant",
            parentID: "msg_ddea560fd001mnSF0ssrplOLZq",
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                metadata: { sessionId: "ses_tied_one" },
              },
            },
          ],
        },
        {
          info: {
            role: "assistant",
            parentID: "msg_ddea560fd001mnSF0ssrplOLZq",
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "error",
                output: "task_id: ses_tied_two",
              },
            },
          ],
        },
      ],
    });

    expect(result).toBeUndefined();
  });

  it("prefers parent-message linkage with metadata tie-breakers", () => {
    const result = resolvePersistedStaleSubtaskFromParentMessages({
      candidate: {
        ...stale,
        summary: "Execute subtask for auth migration",
        agentName: "code",
      },
      messages: [
        {
          info: {
            role: "assistant",
            parentID: "msg_ddea560fd001mnSF0ssrplOLZq",
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { prompt: "Execute subtask for auth migration" },
                metadata: { sessionId: "ses_good_target" },
              },
            },
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { prompt: "something else" },
                metadata: { sessionId: "ses_other_target" },
              },
            },
          ],
        },
      ],
    });

    expect(result).toEqual({
      status: "done",
      targetSessionID: "ses_good_target",
      endedAt: undefined,
    });
  });

  it("does not match by generic title and agent alone", () => {
    const result = resolvePersistedStaleSubtaskFromParentMessages({
      candidate: {
        ...stale,
        title: "Execute subtask",
        summary: undefined,
        agentName: "code",
      },
      messages: [
        {
          info: {
            role: "assistant",
            parentID: "msg_unrelated",
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { description: "Execute subtask", subagent_type: "code" },
                output: "task_id: ses_should_not_match",
              },
            },
          ],
        },
      ],
    });

    expect(result).toBeUndefined();
  });

  it("accepts output task_id with underscores and dashes", () => {
    const result = resolvePersistedStaleSubtaskFromParentMessages({
      candidate: stale,
      messages: [
        {
          info: {
            role: "assistant",
            parentID: "msg_ddea560fd001mnSF0ssrplOLZq",
          },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                output: "delegate finished; task_id: ses_child-01_abc",
              },
            },
          ],
        },
      ],
    });

    expect(result?.targetSessionID).toBe("ses_child-01_abc");
  });

  describe("shared stale-subtask message indexes", () => {
    it("preserves the winner for out-of-order messages", () => {
      // Given a lower-scoring task appears before a later parent-linked task.
      const candidate = {
        ...stale,
        summary: "Run auth migration",
        agentName: "code",
      };
      const messages = [
        {
          info: { role: "assistant", parentID: "msg_unrelated" },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: {
                  description: "Execute subtask",
                  prompt: "Run something else",
                  subagent_type: "code",
                },
                metadata: { sessionId: "ses_lower_score" },
              },
            },
          ],
        },
        {
          info: { role: "assistant", parentID: stale.messageID },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "error",
                output: "task_id: ses_parent_linked",
              },
            },
          ],
        },
      ];

      // When the same snapshot is resolved directly and through its index.
      const indexed = resolvePersistedStaleSubtaskFromParentMessages({
        candidate,
        messages,
        index: buildStaleSubtaskMessageIndex({ messages }),
      });
      const direct = resolvePersistedStaleSubtaskFromParentMessages({
        candidate,
        messages,
      });

      // Then indexing does not change the unique highest-score result.
      expect(indexed).toEqual(direct);
      expect(indexed).toEqual({
        status: "error",
        endedAt: undefined,
        targetSessionID: "ses_parent_linked",
      });
    });

    it("preserves the winner when duplicate titles share lookup buckets", () => {
      // Given two terminal task parts with the same title but only one matching summary.
      const candidate = {
        ...stale,
        summary: "Run auth migration",
        agentName: "code",
      };
      const messages = [
        {
          info: { role: "assistant", parentID: "msg_unrelated" },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: {
                  description: "Execute subtask",
                  prompt: "Run something else",
                  subagent_type: "code",
                },
                metadata: { sessionId: "ses_duplicate_title" },
              },
            },
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: {
                  description: "Execute subtask",
                  prompt: "Run auth migration",
                  subagent_type: "code",
                },
                metadata: { sessionId: "ses_summary_winner" },
              },
            },
          ],
        },
      ];

      // When the duplicate-title snapshot is resolved through the shared index.
      const indexed = resolvePersistedStaleSubtaskFromParentMessages({
        candidate,
        messages,
        index: buildStaleSubtaskMessageIndex({ messages }),
      });
      const direct = resolvePersistedStaleSubtaskFromParentMessages({
        candidate,
        messages,
      });

      // Then overlapping title, summary, and agent buckets do not duplicate an entry.
      expect(indexed).toEqual(direct);
      expect(indexed).toEqual({
        status: "done",
        endedAt: undefined,
        targetSessionID: "ses_summary_winner",
      });
    });

    it("preserves ambiguity when the highest score is tied", () => {
      // Given two terminal tasks have the same summary and therefore the same score.
      const candidate = {
        ...stale,
        summary: "Run auth migration",
      };
      const messages = [
        {
          info: { role: "assistant", parentID: "msg_unrelated_one" },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: { prompt: "Run auth migration" },
                metadata: { sessionId: "ses_tied_one" },
              },
            },
          ],
        },
        {
          info: { role: "assistant", parentID: "msg_unrelated_two" },
          parts: [
            {
              type: "tool",
              tool: "task",
              state: {
                status: "error",
                input: { prompt: "Run auth migration" },
                metadata: { sessionId: "ses_tied_two" },
              },
            },
          ],
        },
      ];

      // When the tied snapshot is resolved directly and through its summary bucket.
      const indexed = resolvePersistedStaleSubtaskFromParentMessages({
        candidate,
        messages,
        index: buildStaleSubtaskMessageIndex({ messages }),
      });
      const direct = resolvePersistedStaleSubtaskFromParentMessages({
        candidate,
        messages,
      });

      // Then both paths fail closed on the tied highest score.
      expect(indexed).toEqual(direct);
      expect(indexed).toBeUndefined();
    });
  });
});

describe("no-target persisted stale fallback safety", () => {
  it("allows closure only when stale and with no recent parent activity", () => {
    const nowMs = Date.now();
    const staleThresholdMs = defaultStaleRunningThresholdMs();

    expect(
      canSafelyCloseNoTargetPersistedCandidate({
        nowMs,
        staleThresholdMs,
        startedMs: staleThresholdMs + 1,
        updatedMs: staleThresholdMs + 1,
        latestMessageActivityAtMs: nowMs - staleThresholdMs - 1,
      }),
    ).toBe(true);

    expect(
      canSafelyCloseNoTargetPersistedCandidate({
        nowMs,
        staleThresholdMs,
        startedMs: staleThresholdMs + 1,
        updatedMs: staleThresholdMs + 1,
        latestMessageActivityAtMs: nowMs - 1_000,
      }),
    ).toBe(false);

    expect(
      canSafelyCloseNoTargetPersistedCandidate({
        nowMs,
        staleThresholdMs: 0,
        startedMs: staleThresholdMs + 1,
        updatedMs: staleThresholdMs + 1,
      }),
    ).toBe(false);
  });
});
