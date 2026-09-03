export interface SidebarRowGeometry {
  readonly id: string;
  readonly height: number;
}

export interface SidebarIndexedRow extends SidebarRowGeometry {
  readonly index: number;
  readonly top: number;
  readonly bottom: number;
  readonly gapAfter: number;
}

export interface SidebarRowLayoutIndex {
  readonly rows: readonly SidebarIndexedRow[];
  readonly rowByID: ReadonlyMap<string, SidebarIndexedRow>;
  readonly contentHeight: number;
  /**
   * Clamped visible height for the sidebar list. Always in
   * `[1, SUBAGENTS_MAX_LIST_HEIGHT]`. Pre-computed here so the sidebar does
   * not need a separate `createMemo` to derive the value on every render.
   */
  readonly listHeight: number;
}

export interface SidebarRowWindow {
  readonly rows: readonly SidebarIndexedRow[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly visibleStartIndex: number;
  readonly beforeHeight: number;
  readonly afterHeight: number;
}

export interface SidebarSelectionActivation {
  readonly selectedRowID?: string;
  readonly mountedActivations: ReadonlyMap<string, () => void>;
  readonly targetSessionID?: string;
  readonly navigate: (targetSessionID: string | undefined) => void;
}

export const SIDEBAR_ROW_WINDOW_OVERSCAN_ROWS = 2 as const;
export const SIDEBAR_LIST_MAX_HEIGHT = 5 as const;
export const SIDEBAR_LIST_MIN_HEIGHT = 1 as const;

function positiveGeometry(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function firstRowEndingAfter(
  rows: readonly SidebarIndexedRow[],
  offset: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const row = rows[middle];
    if (row && row.bottom > offset) high = middle;
    else low = middle + 1;
  }
  return Math.min(low, rows.length - 1);
}

function firstRowStartingAtOrAfter(
  rows: readonly SidebarIndexedRow[],
  offset: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const row = rows[middle];
    if (row && row.top >= offset) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function buildSidebarRowLayoutIndex(
  rows: readonly SidebarRowGeometry[],
  gap: number,
): SidebarRowLayoutIndex {
  const normalizedGap = Number.isFinite(gap) && gap >= 0 ? gap : 0;
  const indexedRows: SidebarIndexedRow[] = [];
  const rowByID = new Map<string, SidebarIndexedRow>();
  let top = 0;

  for (const [index, row] of rows.entries()) {
    if (rowByID.has(row.id)) {
      // Duplicate row id silently collapses the second occurrence. Surface
      // the upstream bug in tests; in production this branch is unreachable
      // because sidebar rows are projected from `state.children` keys which
      // are themselves unique.
      throw new Error(
        `buildSidebarRowLayoutIndex: duplicate row id ${row.id} at index ${index}`,
      );
    }
    const height = positiveGeometry(row.height, 1);
    const gapAfter = index < rows.length - 1 ? normalizedGap : 0;
    const indexedRow: SidebarIndexedRow = {
      id: row.id,
      height,
      index,
      top,
      bottom: top + height,
      gapAfter,
    };
    indexedRows.push(indexedRow);
    rowByID.set(row.id, indexedRow);
    top = indexedRow.bottom + indexedRow.gapAfter;
  }

  return {
    rows: indexedRows,
    rowByID,
    contentHeight: top,
    listHeight: Math.max(
      SIDEBAR_LIST_MIN_HEIGHT,
      Math.min(SIDEBAR_LIST_MAX_HEIGHT, top),
    ),
  };
}

export function resolveSidebarRowWindow(
  layout: SidebarRowLayoutIndex,
  scrollTop: number,
  viewportHeight: number,
): SidebarRowWindow {
  if (layout.rows.length === 0) {
    return {
      rows: [],
      startIndex: 0,
      endIndex: 0,
      visibleStartIndex: 0,
      beforeHeight: 0,
      afterHeight: 0,
    };
  }

  const height = positiveGeometry(viewportHeight, 1);
  const requestedTop = Number.isFinite(scrollTop) ? scrollTop : 0;
  const viewportTop = Math.max(
    0,
    Math.min(requestedTop, Math.max(0, layout.contentHeight - height)),
  );
  const viewportBottom = viewportTop + height;
  const firstVisible = firstRowEndingAfter(layout.rows, viewportTop);
  const visibleEnd = Math.max(
    firstVisible + 1,
    firstRowStartingAtOrAfter(layout.rows, viewportBottom),
  );
  const startIndex = Math.max(
    0,
    firstVisible - SIDEBAR_ROW_WINDOW_OVERSCAN_ROWS,
  );
  const endIndex = Math.min(
    layout.rows.length,
    visibleEnd + SIDEBAR_ROW_WINDOW_OVERSCAN_ROWS,
  );
  const rows = layout.rows.slice(startIndex, endIndex);
  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    rows,
    startIndex,
    endIndex,
    visibleStartIndex: firstVisible,
    beforeHeight: first?.top ?? 0,
    afterHeight: last
      ? Math.max(0, layout.contentHeight - last.bottom - last.gapAfter)
      : 0,
  };
}

export function resolveSidebarSelectedRowID(
  layout: SidebarRowLayoutIndex,
  selectedRowID: string | undefined,
): string | undefined {
  if (selectedRowID && layout.rowByID.has(selectedRowID)) return selectedRowID;
  return layout.rows[0]?.id;
}

export function moveSidebarRowSelection(
  layout: SidebarRowLayoutIndex,
  selectedRowID: string | undefined,
  delta: number,
): string | undefined {
  if (layout.rows.length === 0) return undefined;
  const currentIndex = selectedRowID
    ? layout.rowByID.get(selectedRowID)?.index
    : undefined;
  const fallbackIndex = delta > 0 ? 0 : layout.rows.length - 1;
  const nextIndex = Math.max(
    0,
    Math.min(
      layout.rows.length - 1,
      currentIndex === undefined ? fallbackIndex : currentIndex + delta,
    ),
  );
  return layout.rows[nextIndex]?.id;
}

export function activateSidebarSelection(
  input: SidebarSelectionActivation,
): void {
  const mountedActivation = input.selectedRowID
    ? input.mountedActivations.get(input.selectedRowID)
    : undefined;
  if (mountedActivation) {
    mountedActivation();
    return;
  }
  input.navigate(input.targetSessionID);
}
