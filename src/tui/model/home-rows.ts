/**
 * The rows of Home that can be selected, in screen order. The reducer moves through them and the view draws
 * them, so the two cannot disagree on what is selected.
 */
import { isTerminal, TERMINAL_STATUSES } from '../../domain/state.ts';
import type { BoardRow } from '../client/schemas.ts';
import type { TuiState } from './state.ts';

export type HomeRow =
  | { readonly kind: 'attention'; readonly task: BoardRow }
  | { readonly kind: 'task'; readonly task: BoardRow }
  | {
      readonly kind: 'finished_toggle';
      readonly count: number;
      readonly open: boolean;
    }
  | { readonly kind: 'finished'; readonly task: BoardRow };

function finishedCount(s: TuiState): number {
  const counts = s.board?.counts.by_status ?? {};
  return TERMINAL_STATUSES.reduce((n, st) => n + (counts[st] ?? 0), 0);
}

export function homeRows(s: TuiState): readonly HomeRow[] {
  if (s.board === null) return [];
  // The daemon narrows this group by project only; a status filter holds for the whole screen (FR-008).
  const { status } = s.filters;
  const listed = s.board.attention.items.filter((t) => status === null || t.status === status);
  // A task already in `Needs you` is one row, so moving down never lands on the same task twice.
  const seen = new Set(listed.map((t) => t.task_id));
  // The group is capped; a task past the cap that this page shows still needs the user.
  const attention = [
    ...listed,
    ...s.board.items.filter((t) => t.needs_user && !seen.has(t.task_id)),
  ];
  const inGroup = new Set(attention.map((t) => t.task_id));
  const rest = s.board.items.filter((t) => !inGroup.has(t.task_id));
  const rows: HomeRow[] = attention.map((task) => ({
    kind: 'attention',
    task,
  }));
  // A status filter names what the user wants to see, so nothing under it is folded away.
  const folds = status === null;
  for (const task of rest)
    if (!folds || !isTerminal(task.status)) rows.push({ kind: 'task', task });
  if (folds) {
    const count = finishedCount(s);
    if (count > 0) rows.push({ kind: 'finished_toggle', count, open: s.finishedOpen });
    if (s.finishedOpen)
      for (const task of rest) if (isTerminal(task.status)) rows.push({ kind: 'finished', task });
  }
  return rows;
}

/** The row holding the selection, or -1. Follows the task, not the position (EC-013). */
export function selectedRowIndex(s: TuiState, rows: readonly HomeRow[] = homeRows(s)): number {
  return rows.findIndex((r) =>
    r.kind === 'finished_toggle'
      ? s.finishedSelected
      : !s.finishedSelected && r.task.task_id === s.selectedTaskId,
  );
}

/** Puts the selection on row `index`, clamped; with nothing to select there is none. */
export function selectRow(
  s: TuiState,
  index: number,
  rows: readonly HomeRow[] = homeRows(s),
): TuiState {
  const at = Math.min(Math.max(0, index), rows.length - 1);
  const row = rows[at];
  if (row === undefined)
    return {
      ...s,
      selectedTaskId: null,
      finishedSelected: false,
      selectedIndex: 0,
    };
  return row.kind === 'finished_toggle'
    ? { ...s, selectedTaskId: null, finishedSelected: true, selectedIndex: at }
    : {
        ...s,
        selectedTaskId: row.task.task_id,
        finishedSelected: false,
        selectedIndex: at,
      };
}

/** After new data: the same task if it is still listed, else whatever now sits where it was. */
export function keepSelection(s: TuiState): TuiState {
  const rows = homeRows(s);
  const at = selectedRowIndex(s, rows);
  return at >= 0 ? { ...s, selectedIndex: at } : selectRow(s, s.selectedIndex, rows);
}
