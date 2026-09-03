import type { SubagentTreeRow } from "./projection.js";
import { isRealSessionID, trustedTargetSessionID } from "./subagent-classification.js";
import type { PendingSidebarRefocus } from "./tui-focus.js";

const TREE_INDENT_COLUMNS_PER_DEPTH = 2 as const;
export const SUBAGENT_TREE_ROW_PREFIX_COLUMNS = 5 as const;

export interface TreeRowLayout {
  readonly indentColumns: number;
  readonly labelWidth: number;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function resolveTreeRowLayout(input: {
  readonly depth: number;
  readonly rowWidth: number;
  readonly fixedColumns: number;
  readonly minimumLabelWidth: number;
}): TreeRowLayout {
  const depth = nonNegativeInteger(input.depth);
  const rowWidth = nonNegativeInteger(input.rowWidth);
  const fixedColumns = nonNegativeInteger(input.fixedColumns);
  const minimumLabelWidth = nonNegativeInteger(input.minimumLabelWidth);
  const maximumIndent = Math.max(
    0,
    rowWidth - fixedColumns - minimumLabelWidth,
  );
  const indentColumns = Math.min(
    maximumIndent,
    depth * TREE_INDENT_COLUMNS_PER_DEPTH,
  );

  return {
    indentColumns,
    labelWidth: Math.max(
      minimumLabelWidth,
      rowWidth - fixedColumns - indentColumns,
    ),
  };
}

export function treeRowsLayoutSignature(
  rows: readonly SubagentTreeRow[],
): string {
  let signature = "";
  for (const { child, depth } of rows) {
    const tokens = child.tokens;
    const model = child.model;
    signature +=
      `${child.id}\u0001${depth}\u0001${child.status}\u0001${child.title}` +
      `\u0001${child.summary ?? ""}\u0001${child.agentName ?? ""}` +
      `\u0001${tokens?.input ?? ""}\u0001${tokens?.output ?? ""}` +
      `\u0001${tokens?.total ?? ""}\u0001${tokens?.contextPercent ?? ""}` +
      `\u0001${model?.providerID ?? ""}\u0001${model?.modelID ?? ""}` +
      `\u0001${model?.variant ?? ""}|`;
  }
  return signature;
}

export function resolveSubagentTreeRowTargetSessionID(
  row: SubagentTreeRow,
): string | undefined {
  return (
    trustedTargetSessionID(row.child) ??
    (isRealSessionID(row.child.id) ? row.child.id : undefined)
  );
}

export function activateSubagentTreeRow(input: {
  readonly row: SubagentTreeRow;
  readonly showCompletedHistory: boolean;
  readonly remember: (
    pending: PendingSidebarRefocus & { readonly showCompletedHistory: boolean },
  ) => void;
  readonly navigate: (targetSessionID: string) => void;
}): void {
  const targetSessionID = resolveSubagentTreeRowTargetSessionID(input.row);
  if (!targetSessionID) return;

  input.remember({
    parentSessionID: input.row.parentSessionID,
    childSessionID: targetSessionID,
    childRowID: input.row.child.id,
    showCompletedHistory: input.showCompletedHistory,
  });
  input.navigate(targetSessionID);
}
