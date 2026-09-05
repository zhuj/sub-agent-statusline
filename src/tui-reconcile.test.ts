import { expect, it } from "vitest";
import type { ChildSessionState } from "./state.js";
import { createRunningReconcileSelector, selectRunningReconcileCandidates } from "./tui-reconcile.js";

const NOW_MS = Date.parse("2026-04-30T10:10:00.000Z");
const OLD_CANDIDATE_AGE_MS = 300_000;

it.each([10, 70, 200])("fairly schedules %i active sessions with a budget of 32", (count) => {
  const children = Array.from({ length: count }, (_, index) => {
    const id = `ses_fair_${String(index).padStart(3, "0")}`;
    return child({ id, targetSessionID: id, parentID: "ses_current" });
  });
  const input = {
    children, currentSessionID: "ses_current", nowMs: NOW_MS,
    maxCandidates: 32, oldCandidateAgeMs: OLD_CANDIDATE_AGE_MS,
  };
  const schedule = createRunningReconcileSelector();
  const seen = new Set<string>();
  for (let cycle = 0; cycle < Math.ceil(count / 32); cycle += 1) {
    const batch = schedule(input);
    expect(batch).toHaveLength(Math.min(32, count - seen.size));
    for (const candidate of batch) {
      expect(seen.has(candidate.childID)).toBe(false);
      seen.add(candidate.childID);
    }
  }
  expect(seen.size).toBe(count);
  expect(schedule(input)).toHaveLength(Math.min(count, 32));
});

it("keeps backoff exclusions when a scheduling round resets", () => {
  const children = ["ses_a", "ses_b", "ses_c"].map((id) =>
    child({ id, targetSessionID: id, parentID: "ses_current" }),
  );
  const schedule = createRunningReconcileSelector();
  const input = {
    children, currentSessionID: "ses_current", nowMs: NOW_MS, maxCandidates: 2,
    oldCandidateAgeMs: OLD_CANDIDATE_AGE_MS, excludedTargetIDs: new Set(["ses_a"]),
  };
  for (let cycle = 0; cycle < 2; cycle += 1) {
    expect(new Set(schedule(input).map((candidate) => candidate.childID))).toEqual(new Set(["ses_b", "ses_c"]));
  }
  expect(schedule({ ...input, excludedTargetIDs: new Set() }).map((candidate) => candidate.childID)).toEqual(["ses_a"]);
});

it("selects ten active nested leaves among 200 mostly completed sessions", () => {
  const leaves: string[] = [];
  const sessions: ChildSessionState[] = [];
  for (let branch = 0; branch < 10; branch += 1) {
    const depth = 2 + branch % 4;
    for (let level = 0; level < depth; level += 1) {
      const id = `ses_branch_${branch}_${level}`;
      const running = level === depth - 1;
      if (running) leaves.push(id);
      sessions.push(child({ id, targetSessionID: id,
        parentID: level === 0 ? "ses_current" : `ses_branch_${branch}_${level - 1}`,
        status: running ? "running" : "done",
        startedAt: "2026-04-30T10:09:59.000Z", updatedAt: "2026-04-30T10:09:59.000Z",
      }));
    }
  }
  while (sessions.length < 200) {
    const id = `ses_other_${sessions.length}`;
    sessions.push(child({ id, targetSessionID: id, status: "done" }));
  }
  expect(sessions.filter((item) => item.status === "running")).toHaveLength(10);
  expect(new Set(select(sessions, "ses_current", 32).map((item) => item.childID))).toEqual(new Set(leaves));
});

function child(
  overrides: Partial<ChildSessionState> = {},
): ChildSessionState {
  return {
    id: "ses_child",
    title: "Child",
    parentID: "ses_parent",
    source: "session",
    targetSessionID: "ses_child",
    status: "running",
    color: "yellow",
    startedAt: "2026-04-30T10:00:00.000Z",
    updatedAt: "2026-04-30T10:00:00.000Z",
    ...overrides,
  };
}

function select(
  children: readonly ChildSessionState[],
  currentSessionID = "ses_current",
  maxCandidates = 8,
) {
  return selectRunningReconcileCandidates({
    children,
    currentSessionID,
    nowMs: NOW_MS,
    maxCandidates,
    oldCandidateAgeMs: OLD_CANDIDATE_AGE_MS,
  });
}

it("excludes backoff targets before filling the candidate budget", () => {
  const candidates = ["ses_excluded", "ses_kept"].map((id) =>
    child({ id, targetSessionID: id, parentID: "ses_current" }),
  );
  expect(selectRunningReconcileCandidates({
    children: candidates, currentSessionID: "ses_current", nowMs: NOW_MS,
    maxCandidates: 1, oldCandidateAgeMs: OLD_CANDIDATE_AGE_MS,
    excludedTargetIDs: new Set(["ses_excluded"]),
  }).map((item) => item.childID)).toEqual(["ses_kept"]);
});

it("applies eligibility before the cap and preserves current-session then old fallback order", () => {
  const ineligible = Array.from({ length: 8 }, (_, index) =>
    child({
      id: `tool:${index}`,
      source: "tool",
      targetSessionID: undefined,
      parentID: "ses_current",
      startedAt: "2026-04-30T10:09:59.000Z",
      updatedAt: "2026-04-30T10:09:59.000Z",
    }),
  );
  const current = child({
    id: "ses_current_child",
    parentID: "ses_current",
    targetSessionID: "ses_current_child",
  });
  const oldOther = child({
    id: "ses_old_other",
    parentID: "ses_other",
    targetSessionID: "ses_old_other",
    startedAt: "2026-04-30T09:00:00.000Z",
    updatedAt: "2026-04-30T09:00:00.000Z",
  });

  const selected = select([...ineligible, oldOther, current]);

  expect(selected.map((candidate) => candidate.childID)).toEqual([
    "ses_current_child",
    "ses_old_other",
  ]);
});

it("resolves one same-parent session from indexed evidence and preserves metadata", () => {
  const real = child({
    id: "ses_real",
    parentID: "ses_other",
    targetSessionID: "ses_real",
    status: "done",
    color: "green",
  });
  const synthetic = child({
    id: "tool:old",
    parentID: "ses_other",
    messageID: "msg_1",
    source: "tool",
    targetSessionID: undefined,
    title: "Indexed title",
    summary: "Indexed summary",
    agentName: "explore",
    startedAt: "2026-04-30T09:00:00.000Z",
    updatedAt: "2026-04-30T09:00:00.000Z",
  });

  const selected = select([real, synthetic]);

  expect(selected).toEqual([
    {
      childID: "tool:old",
      targetSessionID: "ses_real",
      parentID: "ses_other",
      messageID: "msg_1",
      source: "tool",
      title: "Indexed title",
      summary: "Indexed summary",
      agentName: "explore",
      startedMs: 4_200_000,
      updatedMs: 4_200_000,
    },
  ]);
});

it("fails closed when same-parent indexed evidence is ambiguous", () => {
  const synthetic = child({
    id: "subtask:old",
    parentID: "ses_other",
    messageID: "msg_1",
    source: "subtask",
    targetSessionID: undefined,
    startedAt: "2026-04-30T09:00:00.000Z",
    updatedAt: "2026-04-30T09:00:00.000Z",
  });
  const first = child({
    id: "ses_first",
    parentID: "ses_other",
    status: "done",
    color: "green",
  });
  const second = child({
    id: "ses_second",
    parentID: "ses_other",
    status: "done",
    color: "green",
  });

  const selected = select([first, synthetic, second]);

  expect(selected).toHaveLength(1);
  expect(selected[0]?.childID).toBe("subtask:old");
  expect(selected[0]?.targetSessionID).toBeUndefined();
});

it("preserves original input order for old fallback candidates", () => {
  const first = child({
    id: "ses_first_old",
    parentID: "ses_other",
    targetSessionID: "ses_first_old",
    startedAt: "2026-04-30T08:00:00.000Z",
    updatedAt: "2026-04-30T08:00:00.000Z",
  });
  const second = child({
    id: "ses_second_old",
    parentID: "ses_other",
    targetSessionID: "ses_second_old",
    startedAt: "2026-04-30T09:00:00.000Z",
    updatedAt: "2026-04-30T09:00:00.000Z",
  });

  expect(select([first, second]).map((candidate) => candidate.childID)).toEqual([
    "ses_first_old",
    "ses_second_old",
  ]);
});

it("keeps distinct old fallback children that resolve to the same target", () => {
  const real = child({
    id: "ses_shared_target",
    parentID: "ses_other",
    status: "done",
    color: "green",
  });
  const first = child({
    id: "tool:first_old",
    parentID: "ses_other",
    source: "tool",
    targetSessionID: undefined,
    startedAt: "2026-04-30T09:00:00.000Z",
    updatedAt: "2026-04-30T09:00:00.000Z",
  });
  const second = child({
    id: "tool:second_old",
    parentID: "ses_other",
    source: "tool",
    targetSessionID: undefined,
    startedAt: "2026-04-30T08:00:00.000Z",
    updatedAt: "2026-04-30T08:00:00.000Z",
  });

  const selected = select([first, second, real]);

  expect(selected.map((candidate) => candidate.childID)).toEqual([
    "tool:first_old",
    "tool:second_old",
  ]);
  expect(selected.map((candidate) => candidate.targetSessionID)).toEqual([
    "ses_shared_target",
    "ses_shared_target",
  ]);
});

it("deduplicates a current-session candidate also eligible for old fallback", () => {
  const candidate = child({
    id: "ses_both",
    parentID: "ses_current",
    startedAt: "2026-04-30T09:00:00.000Z",
    updatedAt: "2026-04-30T09:00:00.000Z",
  });

  expect(select([candidate]).map((item) => item.childID)).toEqual(["ses_both"]);
});

it("selects the bounded byPriority top candidates without exceeding the hard max", () => {
  const candidates = Array.from({ length: 10 }, (_, index) =>
    child({
      id: `ses_${String(index).padStart(2, "0")}`,
      parentID: "ses_current",
      targetSessionID: `ses_${String(index).padStart(2, "0")}`,
      startedAt: `2026-04-30T10:0${index}:00.000Z`,
      updatedAt: "2026-04-30T10:09:59.000Z",
    }),
  );

  expect(select(candidates, "ses_current", 3).map((item) => item.childID)).toEqual([
    "ses_09",
    "ses_08",
    "ses_07",
  ]);
});
