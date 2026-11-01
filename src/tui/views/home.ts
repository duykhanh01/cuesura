/**
 * Home: which projects, what is going on, and what needs the user (FR-005–FR-007, FR-010, EC-005). Two rows
 * per task keep title, project, status, activity, time, mode and PR at 80 columns. Scrolling follows the
 * selection in whole screens, so the view needs no memory of its own and a resize loses nothing (EC-002).
 */
import { TASK_STATUSES, isTerminal } from '../../domain/state.ts';
import type { BoardRow } from '../client/schemas.ts';
import {
  activityLine,
  markLegend,
  statusMark,
  timeInStatus,
  todo,
} from '../model/activity.ts';
import {
  homeRows,
  selectedRowIndex,
  type HomeRow,
} from '../model/home-rows.ts';
import { PAGE_LIMIT, type TuiState } from '../model/state.ts';
import {
  joinSafe,
  sanitize,
  uiText,
  type SafeText,
} from '../terminal/safe-text.ts';
import type { Frame, Style } from '../terminal/screen.ts';
import { padEnd, truncate } from '../terminal/width.ts';
import { filterLine } from './filters.ts';
import type { Body } from './layout.ts';

const MARGIN = 2;
const STATUS_COLUMN = 12;
const PROJECT_COLUMN = 16;
const TIME_COLUMN = 11;

/** Written beside the projects whenever the token does not see everything (EC-009). */
export const SCOPE_NOTE = "Showing projects in this token's scope";

function projectsLine(s: TuiState): SafeText {
  if (s.projects === null) return uiText('Projects: not read yet');
  if (s.projects.length === 0) return uiText('Projects: none in scope');
  return joinSafe([
    uiText('Projects: '),
    joinSafe(
      s.projects.map((p) => sanitize(p.id)),
      uiText(', '),
    ),
  ]);
}

function countsLine(s: TuiState): SafeText | null {
  if (s.board === null) return null;
  const counts = s.board.counts.by_status;
  const parts = TASK_STATUSES.flatMap((status) => {
    const n = counts[status];
    return n === undefined ? [] : [`${status} ${n}`];
  });
  return uiText(`Tasks: ${parts.length === 0 ? 'none' : parts.join('  ')}`);
}

/** How many tasks this view holds, from the daemon's counts: a page says nothing about it (EC-005). */
function totalInView(s: TuiState): number {
  const counts = s.board?.counts.by_status ?? {};
  return TASK_STATUSES.filter(
    (st) => s.filters.status !== null || s.finishedOpen || !isTerminal(st),
  ).reduce((n, st) => n + (counts[st] ?? 0), 0);
}

function pageLine(s: TuiState): SafeText | null {
  if (s.board === null) return null;
  if (s.cursors.length === 0 && s.board.next_cursor === null) return null;
  const first = s.cursors.length * PAGE_LIMIT;
  const shown = s.board.items.length;
  const more = s.board.next_cursor === null ? '' : ' · PgDn at the end: next';
  return uiText(
    `Page ${s.cursors.length + 1}: tasks ${first + (shown === 0 ? 0 : 1)}–${first + shown} of ${totalInView(s)}${more}`,
  );
}

type Line =
  | { readonly kind: 'heading'; readonly text: SafeText }
  | { readonly kind: 'text'; readonly text: SafeText; readonly row: number }
  | { readonly kind: 'task'; readonly task: BoardRow; readonly row: number };

function rowLines(row: HomeRow, index: number): Line[] {
  if (row.kind === 'finished_toggle')
    return [
      {
        kind: 'text',
        row: index,
        text: uiText(
          row.open
            ? `▾ Finished (${row.count}) — Enter to hide`
            : `▸ Finished (${row.count}) — Enter to show`,
        ),
      },
    ];
  const action = todo(row.task);
  const doing = activityLine(row.task);
  return [
    { kind: 'task', task: row.task, row: index },
    {
      kind: 'text',
      row: index,
      text:
        row.kind === 'attention' && action !== null
          ? joinSafe([uiText('    To do: '), action, uiText(' — '), doing])
          : joinSafe([uiText('    '), doing]),
    },
  ];
}

function listLines(s: TuiState, rows: readonly HomeRow[]): Line[] {
  const lines: Line[] = [];
  const attention = rows.filter((r) => r.kind === 'attention').length;
  if (attention > 0) {
    // Past the daemon's cap the count is only what is known so far.
    const more = s.board?.attention.truncated === true ? '+' : '';
    lines.push({
      kind: 'heading',
      text: uiText(`Needs you (${attention}${more})`),
    });
  }
  let inTasks = false;
  rows.forEach((row, i) => {
    if (row.kind === 'task' && !inTasks) {
      inTasks = true;
      lines.push({ kind: 'heading', text: uiText('Tasks') });
    }
    lines.push(...rowLines(row, i));
  });
  return lines;
}

function drawTask(
  frame: Frame,
  y: number,
  s: TuiState,
  task: BoardRow,
  selected: boolean,
): void {
  const cols = s.size.cols;
  const base: Style = selected ? { inverse: true } : {};
  const mark = statusMark(task.status);
  const titleX = MARGIN + STATUS_COLUMN;
  const titleWidth = Math.max(
    8,
    cols - titleX - PROJECT_COLUMN - TIME_COLUMN - 2,
  );
  frame.put(0, y, padEnd(uiText(selected ? '› ' : ''), cols), base);
  frame.put(MARGIN, y, padEnd(mark.text, STATUS_COLUMN), {
    ...base,
    ...(mark.color === undefined ? {} : { fg: mark.color }),
  });
  frame.put(titleX, y, truncate(task.title, titleWidth), base);
  const projectX = titleX + titleWidth + 1;
  frame.put(
    projectX,
    y,
    truncate(sanitize(task.project), PROJECT_COLUMN),
    base,
  );
  frame.put(
    projectX + PROJECT_COLUMN + 1,
    y,
    truncate(timeInStatus(task, s.lastUpdatedAt), TIME_COLUMN),
    base,
  );
}

/** The first line to show: whole screens, moved only as far as keeps the selected row entirely in view. */
function firstLine(
  lines: readonly Line[],
  selected: number,
  height: number,
): number {
  const start = lines.findIndex(
    (l) => l.kind !== 'heading' && l.row === selected,
  );
  if (start < 0 || height <= 0) return 0;
  const screen = Math.floor(start / height) * height;
  const end = start + (lines[start]?.kind === 'task' ? 1 : 0);
  return end >= screen + height ? start : screen;
}

function drawList(
  frame: Frame,
  s: TuiState,
  top: number,
  height: number,
  rows: readonly HomeRow[],
): void {
  const cols = s.size.cols;
  const selected = selectedRowIndex(s, rows);
  const lines = listLines(s, rows);
  const offset = firstLine(lines, selected, height);
  lines.slice(offset, offset + height).forEach((line, i) => {
    const y = top + i;
    if (line.kind === 'heading') {
      frame.put(0, y, truncate(line.text, cols), { bold: true });
    } else if (line.kind === 'task') {
      drawTask(frame, y, s, line.task, line.row === selected);
    } else if (rows[line.row]?.kind === 'finished_toggle') {
      const on = line.row === selected;
      frame.put(
        0,
        y,
        truncate(joinSafe([uiText(on ? '› ' : '  '), line.text]), cols),
        on ? { inverse: true } : {},
      );
    } else {
      frame.put(0, y, truncate(line.text, cols));
    }
  });
}

export const homeBody =
  (s: TuiState, opts: { readonly color: boolean }): Body =>
  (frame, top, height) => {
    if (height <= 0) return;
    const cols = s.size.cols;
    const header: (SafeText | null)[] = [
      projectsLine(s),
      s.caller?.scope === 'limited' ? uiText(SCOPE_NOTE) : null,
      filterLine(s),
      opts.color ? null : markLegend(),
      countsLine(s),
      pageLine(s),
    ];
    const shown = header
      .filter((line) => line !== null)
      .slice(0, Math.max(1, height >> 1));
    shown.forEach((line, i) => frame.put(0, top + i, truncate(line, cols)));
    const listTop = top + shown.length;
    const room = height - shown.length;
    if (room <= 0) return;

    if (s.board === null) {
      // Before any answer the banner already says it is connecting.
      if (s.lastUpdatedAt === null && !s.stale) return;
      const why = s.stale ? 'No data for this view yet.' : 'Reading this view…';
      frame.put(0, listTop, truncate(uiText(why), cols));
      return;
    }
    const rows = homeRows(s);
    if (rows.length === 0) {
      frame.put(0, listTop, truncate(uiText('No tasks in this view.'), cols));
      return;
    }
    drawList(frame, s, listTop, room, rows);
  };
