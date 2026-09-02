import { describe, expect, it } from "vitest";

import {
  classifyTuiEventOwnership,
  createTuiEventOwnershipGate,
  type TuiEventOwnershipContext,
} from "./tui-event-ownership.js";

const CURRENT_DIRECTORY = "/workspace/current";
const FOREIGN_DIRECTORY = "/workspace/foreign";

function context(
  overrides: Partial<TuiEventOwnershipContext> = {},
): TuiEventOwnershipContext {
  return {
    currentDirectory: CURRENT_DIRECTORY,
    routeSessionID: "ses_root",
    children: {},
    getSessionDirectory: () => undefined,
    ...overrides,
  };
}

function sessionEvent(
  type: "session.created" | "session.updated",
  directory: string,
) {
  return {
    type,
    properties: {
      sessionID: "ses_child",
      info: {
        id: "ses_child",
        parentID: "ses_root",
        directory,
      },
    },
  };
}

function idleEvent(sessionID: string) {
  return { type: "session.idle", properties: { sessionID } };
}

const DIRECTORY_LESS_EVENTS = [
  {
    type: "session.status",
    properties: { sessionID: "ses_root", status: { type: "busy" } },
  },
  { type: "session.idle", properties: { sessionID: "ses_root" } },
  { type: "session.error", properties: { sessionID: "ses_root" } },
  {
    type: "message.updated",
    properties: {
      sessionID: "ses_root",
      info: { id: "msg_1", sessionID: "ses_root", role: "user" },
    },
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_root",
      part: {
        id: "part_1",
        messageID: "msg_1",
        sessionID: "ses_root",
        type: "text",
      },
      time: 1,
    },
  },
] as const;

describe("classifyTuiEventOwnership", () => {
  it("classifies all seven current-directory event families as owned", () => {
    // Given
    const events = [
      sessionEvent("session.created", CURRENT_DIRECTORY),
      sessionEvent("session.updated", CURRENT_DIRECTORY),
      ...DIRECTORY_LESS_EVENTS,
    ];

    // When
    const decisions = events.map((event) =>
      classifyTuiEventOwnership(event, context()),
    );

    // Then
    expect(decisions.map((decision) => decision.kind)).toEqual(
      Array.from({ length: 7 }, () => "owned"),
    );
  });

  it("classifies all seven explicitly foreign event families as foreign", () => {
    // Given
    const events = [
      sessionEvent("session.created", FOREIGN_DIRECTORY),
      sessionEvent("session.updated", FOREIGN_DIRECTORY),
      ...DIRECTORY_LESS_EVENTS,
    ];
    const foreignContext = context({
      getSessionDirectory: () => FOREIGN_DIRECTORY,
    });

    // When
    const decisions = events.map((event) =>
      classifyTuiEventOwnership(event, foreignContext),
    );

    // Then
    expect(decisions.map((decision) => decision.kind)).toEqual(
      Array.from({ length: 7 }, () => "foreign"),
    );
  });

  it.each([
    ["unsupported", { type: "session.deleted", properties: {} }],
    ["missing properties", { type: "session.idle" }],
    ["error without ID", { type: "session.error", properties: {} }],
    [
      "session ID mismatch",
      {
        type: "session.created",
        properties: {
          sessionID: "ses_outer",
          info: { id: "ses_inner", directory: CURRENT_DIRECTORY },
        },
      },
    ],
    [
      "message session ID mismatch",
      {
        type: "message.updated",
        properties: {
          sessionID: "ses_outer",
          info: { sessionID: "ses_inner" },
        },
      },
    ],
    [
      "part session ID mismatch",
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_outer",
          part: { sessionID: "ses_inner" },
        },
      },
    ],
    [
      "status without discriminator",
      { type: "session.status", properties: { sessionID: "ses_root", status: {} } },
    ],
    [
      "message without identity",
      {
        type: "message.updated",
        properties: { sessionID: "ses_root", info: { sessionID: "ses_root" } },
      },
    ],
    [
      "part without identity",
      {
        type: "message.part.updated",
        properties: { sessionID: "ses_root", part: { sessionID: "ses_root" } },
      },
    ],
  ])("fails closed for %s", (_name, event) => {
    // Given / When
    const decision = classifyTuiEventOwnership(event, context());

    // Then
    expect(decision.kind).toBe("unknown");
  });

  it("trusts anchored session IDs but not heuristic target or synthetic IDs", () => {
    // Given
    const anchored = context({
      children: {
        task_1: {
          id: "task_1",
          parentID: "ses_root",
          source: "subtask",
          targetSessionID: "ses_child",
        },
        ses_nested: {
          id: "ses_nested",
          parentID: "ses_root",
          source: "session",
        },
      },
      routeSessionID: "ses_root",
    });

    // When / Then
    expect(classifyTuiEventOwnership(idleEvent("ses_child"), anchored).kind).toBe("unknown");
    expect(classifyTuiEventOwnership(idleEvent("task_1"), anchored).kind).toBe("unknown");
    expect(classifyTuiEventOwnership(idleEvent("ses_nested"), anchored).kind).toBe("owned");
    expect(
      classifyTuiEventOwnership(idleEvent("ses_child"), {
        ...anchored,
        getSessionDirectory: () => CURRENT_DIRECTORY,
      }).kind,
    ).toBe("owned");
    expect(
      classifyTuiEventOwnership(idleEvent("ses_child"), {
        ...anchored,
        getSessionDirectory: () => FOREIGN_DIRECTORY,
      }).kind,
    ).toBe("foreign");
  });
});

describe("TUI event ownership lifetime gate", () => {
  it("latches only a directly evidenced child, not its unknown parent", () => {
    // Given
    const gate = createTuiEventOwnershipGate();
    const evidence = context({ routeSessionID: undefined });

    // When
    const created = gate.accepts(
      sessionEvent("session.created", CURRENT_DIRECTORY),
      evidence,
    );

    // Then
    expect(created).toBe(true);
    expect(gate.accepts(idleEvent("ses_child"), evidence)).toBe(true);
    expect(gate.accepts(idleEvent("ses_root"), evidence)).toBe(false);
    expect(
      createTuiEventOwnershipGate().accepts(
        idleEvent("ses_root"),
        context({ routeSessionID: undefined, getSessionDirectory: () => CURRENT_DIRECTORY }),
      ),
    ).toBe(true);
    expect(createTuiEventOwnershipGate().accepts(idleEvent("ses_root"), context())).toBe(true);
  });

  it("rejects a heuristic target learned after accepting its parent event", () => {
    // Given
    const gate = createTuiEventOwnershipGate();
    const parentToolEvent = {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_root",
        part: { id: "part_1", messageID: "msg_1", sessionID: "ses_root", type: "tool" },
        time: 1,
      },
    };
    const withTarget = context({
      children: {
        task_1: { id: "task_1", parentID: "ses_root", source: "tool", targetSessionID: "ses_foreign" },
      },
    });

    // When / Then
    expect(gate.accepts(parentToolEvent, context())).toBe(true);
    expect(gate.accepts(idleEvent("ses_foreign"), withTarget)).toBe(false);
  });

  it("lets explicit foreign state evidence override an accepted-ID latch", () => {
    // Given
    const gate = createTuiEventOwnershipGate();
    const initial = context({ routeSessionID: undefined });
    gate.accepts(sessionEvent("session.created", CURRENT_DIRECTORY), initial);

    // When
    const accepted = gate.accepts(
      { type: "session.idle", properties: { sessionID: "ses_child" } },
      context({
        routeSessionID: undefined,
        getSessionDirectory: () => FOREIGN_DIRECTORY,
      }),
    );

    // Then
    expect(accepted).toBe(false);
  });

  it("clears accepted-ID latches when the current directory changes", () => {
    // Given
    const gate = createTuiEventOwnershipGate();
    const initial = context({ routeSessionID: undefined });
    gate.accepts(sessionEvent("session.created", CURRENT_DIRECTORY), initial);

    // When
    const accepted = gate.accepts(
      { type: "session.idle", properties: { sessionID: "ses_child" } },
      context({ currentDirectory: "/workspace/next", routeSessionID: undefined }),
    );

    // Then
    expect(accepted).toBe(false);
  });
});
