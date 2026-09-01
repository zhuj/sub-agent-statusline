export type SidebarReturnFocusAction = "none" | "clear-pending" | "focus-prompt";

export type PendingSidebarRefocus = {
  /**
   * Target session id of the child the user was on when they navigated away.
   * Distinct from `childRowID`, which is the synthetic-row id used inside
   * `state.children`.
   */
  parentSessionID: string;
  childSessionID: string;
  childRowID: string;
  showCompletedHistory?: boolean;
};

/**
 * Structural subset of `state.children[childID]` consumed by the focus/refocus
 * helpers in this module. Kept local (and narrower than the full
 * `ChildSessionState` from `./state.js`) to avoid coupling focus logic to
 * child-shape evolution.
 */
export type SidebarChildRef = {
  id: string;
  parentID: string;
  targetSessionID?: string;
};

export type ManagedDeferredCallbacks = {
  readonly schedule: (callback: () => void) => void;
  readonly dispose: () => void;
};

export function createManagedDeferredCallbacks(
  isValid: () => boolean = () => true,
): ManagedDeferredCallbacks {
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;

  return {
    schedule(callback) {
      if (disposed || !isValid()) return;
      const timeout = setTimeout(() => {
        timeouts.delete(timeout);
        if (!disposed && isValid()) callback();
      }, 0);
      timeouts.add(timeout);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timeout of timeouts) clearTimeout(timeout);
      timeouts.clear();
    },
  };
}

export function shouldReleaseSidebarListFocus(input: {
  previousRunningCount?: number;
  runningCount: number;
  listFocusModeActive: boolean;
}): boolean {
  return (
    input.listFocusModeActive &&
    (input.previousRunningCount ?? 0) > 0 &&
    input.runningCount === 0
  );
}

export function resolveSiblingSidebarRefocus(input: {
  pendingSidebarRefocus?: PendingSidebarRefocus;
  routeSessionID?: string;
  children: Record<string, SidebarChildRef> | SidebarChildRef[];
}): Pick<PendingSidebarRefocus, "childSessionID" | "childRowID"> | undefined {
  const { pendingSidebarRefocus, routeSessionID, children } = input;
  if (
    !pendingSidebarRefocus ||
    !routeSessionID ||
    routeSessionID === pendingSidebarRefocus.parentSessionID ||
    routeSessionID === pendingSidebarRefocus.childSessionID
  ) {
    return undefined;
  }

  const sibling = Object.values(children).find(
    (child) =>
      child.parentID === pendingSidebarRefocus.parentSessionID &&
      child.targetSessionID === routeSessionID,
  );
  if (!sibling) return undefined;

  return {
    childSessionID: routeSessionID,
    childRowID: sibling.id,
  };
}

export function resolveSidebarReturnFocusAction(input: {
  pendingSidebarRefocus?: PendingSidebarRefocus;
  previousRouteSessionID?: string;
  routeSessionID?: string;
}): SidebarReturnFocusAction {
  const { pendingSidebarRefocus, previousRouteSessionID, routeSessionID } = input;
  if (!pendingSidebarRefocus || previousRouteSessionID === routeSessionID) {
    return "none";
  }

  if (
    previousRouteSessionID === pendingSidebarRefocus.childSessionID &&
    routeSessionID === pendingSidebarRefocus.parentSessionID
  ) {
    return "focus-prompt";
  }

  if (routeSessionID !== pendingSidebarRefocus.childSessionID) {
    return "clear-pending";
  }

  return "none";
}

export function focusPromptWithDeferredRetry(
  tryFocusPrompt: () => boolean,
  schedule: (callback: () => void) => void = (callback) => {
    setTimeout(callback, 0);
  },
): void {
  schedule(() => {
    if (tryFocusPrompt()) return;
    schedule(() => {
      void tryFocusPrompt();
    });
  });
}
