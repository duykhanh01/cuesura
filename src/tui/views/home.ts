/**
 * Home: which projects, what is going on, and what needs the user (FR-005–FR-007, FR-010, EC-005). One row per
 * task, in columns: mark, title, project, stage dots, what it is doing and time in status. Scrolling follows
 * the selection in whole screens, so the view needs no memory of its own and a resize loses nothing (EC-002).
 */
import { TASK_STATUSES, isTerminal, type TaskStatus } from '../../domain/state.ts';
import { activity, markLegend, statusGlyph, timeInStatus, todo } from '../model/activity.ts';
import { homeRows, selectedRowIndex, type HomeRow } from '../model/home-rows.ts';
import { rowStages } from '../model/stages.ts';
import { PAGE_LIMIT, type TuiState } from '../model/state.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Frame, Style } from '../terminal/screen.ts';
import { displayWidth, truncate } from '../terminal/width.ts';
import { filterLine } from './filters.ts';
import { BOLD, DIM, fg, putSegs, ruleHeading, seg, segsWidth, ui, type Seg } from './ink.ts';
import type { Body } from './layout.ts';
import { dots, DOTS_WIDTH, stepper } from './stepper.ts';

const STATUS_WORD: Readonly<Record<TaskStatus, string>> = {
  PENDING: 'pending',
  READY: 'ready',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

function projectsSegs(s: TuiState): Seg[] {
  if (s.projects === null) return [ui('Projects: not read yet', DIM)];
  if (s.projects.length === 0) return [ui('Projects: none in scope', DIM)];
  return [
    ui('Projects: ', DIM),
    seg(
      joinSafe(
        s.projects.map((p) => sanitize(p.id)),
        uiText(', '),
      ),
    ),
  ];
}

/** `▲ 2 need you   ▶ 3 running …`: what the daemon counted, each status with its mark and colour. */
function summarySegs(s: TuiState, attention: number): Seg[] | null {
  if (s.board === null) return null;
  const counts = s.board.counts.by_status;
  const out: Seg[] = [];
  if (attention > 0) {
    const more = s.board.attention.truncated ? '+' : '';
    out.push(ui(`▲ ${attention}${more} need you`, { fg: 'yellow', bold: true }));
  }
  for (const status of TASK_STATUSES) {
    const n = counts[status];
    if (n === undefined || n === 0) continue;
    const { mark, color } = statusGlyph(status);
    if (out.length > 0) out.push(ui('    '));
    out.push(ui(`${mark} `, fg(color)), ui(`${n} ${STATUS_WORD[status]}`));
  }
  return out.length === 0 ? [ui('No tasks yet', DIM)] : out;
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

type TaskRow = Exclude<HomeRow, { kind: 'finished_toggle' }>;

type Line =
  | { readonly kind: 'static'; readonly segs: readonly Seg[] }
  | { readonly kind: 'toggle'; readonly text: SafeText; readonly row: number }
  | { readonly kind: 'task'; readonly row: number; readonly item: TaskRow }
  | { readonly kind: 'detail'; readonly item: TaskRow };

const actionOf = (row: TaskRow): SafeText | null =>
  row.kind === 'attention' ? todo(row.task) : null;

const BLANK: Line = { kind: 'static', segs: [] };

function listLines(s: TuiState, rows: readonly HomeRow[], cols: number): Line[] {
  const lines: Line[] = [];
  // One blank line between every heading, toggle and task, so the list keeps one rhythm and the stage bars
  // of two tasks never join into columns. A task's detail line stays with its task.
  const gap = (): void => {
    if (lines.length > 0) lines.push(BLANK);
  };
  const attention = rows.filter((r) => r.kind === 'attention').length;
  if (attention > 0) {
    const more = s.board?.attention.truncated === true ? '+' : '';
    lines.push({
      kind: 'static',
      segs: ruleHeading(`Needs you (${attention}${more})`, cols, {
        fg: 'yellow',
        bold: true,
      }),
    });
  }
  let inTasks = false;
  rows.forEach((row, i) => {
    if (row.kind === 'task' && !inTasks) {
      inTasks = true;
      gap();
      lines.push({
        kind: 'static',
        segs: ruleHeading('Tasks', cols, { fg: 'cyan', bold: true }),
      });
    }
    if (row.kind === 'finished_toggle') {
      gap();
      lines.push({
        kind: 'toggle',
        row: i,
        text: uiText(
          row.open
            ? `▾ Finished (${row.count}) — Enter to hide`
            : `▸ Finished (${row.count}) — Enter to show`,
        ),
      });
      return;
    }
    gap();
    lines.push({ kind: 'task', row: i, item: row });
    if (actionOf(row) !== null) lines.push({ kind: 'detail', item: row });
  });
  return lines;
}

/** Column widths for this terminal: the title and the activity share what the fixed columns leave. */
type Columns = {
  readonly title: number;
  readonly project: number;
  readonly doing: number;
  readonly time: number;
};

const TITLE_X = 4;

/** One style for every part of the selected row, so the selection reads as a single colour. */
const SELECTED: Style = { fg: 'cyan', bold: true };

/** Selected row: faint or plain text takes the selection style; yellow and red keep their meaning. */
const highlight = (segs: readonly Seg[]): Seg[] =>
  segs.map((g) =>
    g.style?.fg === 'yellow' || g.style?.fg === 'red' ? g : { ...g, style: SELECTED },
  );

/** The time column fits the longest time shown, so `unavailable` reads whole and `5s` costs little. */
function columns(s: TuiState, cols: number, rows: readonly HomeRow[]): Columns {
  const time = rows.reduce(
    (n, r) =>
      r.kind === 'finished_toggle'
        ? n
        : Math.max(n, displayWidth(timeInStatus(r.task, s.lastUpdatedAt))),
    'In status'.length - 2,
  );
  // Selector and mark, then the gaps between columns and the time at the edge.
  const fixed = TITLE_X + 2 + 2 + DOTS_WIDTH + 2 + 2 + 1 + time;
  const longest = rows.reduce(
    (n, r) => (r.kind === 'finished_toggle' ? n : Math.max(n, displayWidth(r.task.project))),
    7,
  );
  const room = Math.max(24, cols - fixed);
  const project = Math.min(longest, 14, Math.floor(room / 5));
  const title = Math.min(36, Math.max(14, Math.round((room - project) * 0.28)));
  return {
    title,
    project,
    doing: Math.max(8, room - project - title),
    time,
  };
}

function joinDot(parts: readonly SafeText[]): SafeText {
  return joinSafe(parts, uiText(' · '));
}

function extraSegs(task: TaskRow['task']): Seg[] {
  const extra: SafeText[] = [];
  if (task.mode !== null) extra.push(task.mode);
  if (task.pr_ref !== null) extra.push(task.pr_ref);
  return extra.length === 0 ? [] : [seg(joinSafe([uiText(' · '), joinDot(extra)]), DIM)];
}

/**
 * What the row is doing. A task waiting on the user says only what to do; why, mode and PR go on the line
 * under it (`detailSegs`), so the to-do is never the part a narrow terminal cuts.
 */
function doingSegs(row: TaskRow): Seg[] {
  const task = row.task;
  const action = actionOf(row);
  if (action !== null) return [seg(joinSafe([uiText('→ '), action]), { fg: 'yellow' })];
  const tail = extraSegs(task);
  const { status } = task;
  const style: Style =
    status === 'FAILED'
      ? { fg: 'red' }
      : isTerminal(status) || status === 'READY' || status === 'PENDING'
        ? DIM
        : {};
  return [seg(activity(task), style), ...tail];
}

/** The line under a task that waits on the user: its activity, mode and PR, faint (FR-006). */
function detailSegs(row: TaskRow): Seg[] {
  return [seg(joinSafe([uiText('  '), activity(row.task)]), DIM), ...extraSegs(row.task)];
}

function doingX(c: Columns): number {
  return TITLE_X + c.title + 2 + c.project + 2 + DOTS_WIDTH + 2;
}

function drawTask(
  frame: Frame,
  y: number,
  s: TuiState,
  row: TaskRow,
  c: Columns,
  selected: boolean,
  useColor: boolean,
): void {
  const cols = s.size.cols;
  const { task } = row;
  // The selection is a pointer and a bright title, not a reversed row: reversing turns every coloured
  // cell into a block of its own colour.
  if (selected) frame.put(0, y, uiText('›'), SELECTED);
  const { mark, color } = statusGlyph(task.status);
  frame.put(2, y, uiText(mark), fg(color, { bold: true }));
  let x = TITLE_X;
  const titleStyle: Style = selected
    ? SELECTED
    : isTerminal(task.status)
      ? DIM
      : row.kind === 'attention'
        ? BOLD
        : {};
  frame.put(x, y, truncate(task.title, c.title), titleStyle);
  x += c.title + 2;
  frame.put(x, y, truncate(sanitize(task.project), c.project), selected ? SELECTED : DIM);
  x += c.project + 2;
  const stages = rowStages(task);
  if (stages !== null) putSegs(frame, x, y, dots(stages, task.status, useColor), DOTS_WIDTH);
  x += DOTS_WIDTH + 2;
  putSegs(frame, x, y, selected ? highlight(doingSegs(row)) : doingSegs(row), c.doing);
  const time = truncate(timeInStatus(task, s.lastUpdatedAt), c.time);
  frame.put(cols - displayWidth(time) - 1, y, time, selected ? SELECTED : DIM);
}

/** The first line to show: whole screens, moved only as far as keeps the selected row in view. */
function firstLine(lines: readonly Line[], selected: number, height: number): number {
  const at = lines.findIndex(
    (l) => (l.kind === 'task' || l.kind === 'toggle') && l.row === selected,
  );
  if (at < 0 || height <= 0) return 0;
  const screen = Math.floor(at / height) * height;
  return at >= screen + height ? at : screen;
}

function columnHeads(c: Columns, cols: number): Seg[] {
  const heads = [
    ' '.repeat(TITLE_X),
    'Task'.padEnd(c.title + 2),
    'Project'.slice(0, c.project).padEnd(c.project + 2),
    'Stages'.padEnd(DOTS_WIDTH + 2),
    'Now',
  ].join('');
  const right = 'In status';
  const gap = cols - displayWidth(heads) - displayWidth(right) - 1;
  return [ui(gap > 0 ? `${heads}${' '.repeat(gap)}${right}` : heads, DIM)];
}

/** The selected task's stages spelled out, so the dots of every row can be read against them. */
function selectionStages(s: TuiState, row: HomeRow | undefined): Seg[] | null {
  if (row === undefined || row.kind === 'finished_toggle') return null;
  const stages = rowStages(row.task);
  if (stages === null) return null;
  const path = [ui(' '), ...stepper(stages, row.task.status)];
  return segsWidth(path) + 8 <= s.size.cols ? [ui(' Stages ', DIM), ...path] : path;
}

function drawList(
  frame: Frame,
  s: TuiState,
  top: number,
  space: number,
  rows: readonly HomeRow[],
  useColor: boolean,
): void {
  const cols = s.size.cols;
  const selected = selectedRowIndex(s, rows);
  const footer = space > 6 ? selectionStages(s, rows[selected]) : null;
  const height = footer === null ? space : space - 2;
  if (footer !== null) {
    putSegs(frame, 0, top + space - 2, [ui('─'.repeat(cols), DIM)], cols);
    putSegs(frame, 0, top + space - 1, footer, cols);
  }
  const c = columns(s, cols, rows);
  const lines: Line[] = [
    { kind: 'static', segs: columnHeads(c, cols) },
    // The first entry may be a heading or the Finished toggle; the gap keeps the list's one rhythm.
    BLANK,
    ...listLines(s, rows, cols),
  ];
  const offset = firstLine(lines, selected, height);
  lines.slice(offset, offset + height).forEach((line, i) => {
    const y = top + i;
    if (line.kind === 'static') putSegs(frame, 0, y, line.segs, cols);
    else if (line.kind === 'detail')
      putSegs(frame, doingX(c), y, detailSegs(line.item), cols - doingX(c) - 1);
    else if (line.kind === 'toggle') {
      const on = line.row === selected;
      if (on) frame.put(0, y, uiText('›'), SELECTED);
      frame.put(2, y, truncate(line.text, cols - 2), on ? SELECTED : DIM);
    } else drawTask(frame, y, s, line.item, c, line.row === selected, useColor);
  });
}

export const homeBody =
  (s: TuiState, opts: { readonly color: boolean }): Body =>
  (frame, top, height) => {
    if (height <= 0) return;
    const cols = s.size.cols;
    const rows = s.board === null ? [] : homeRows(s);
    const attention = rows.filter((r) => r.kind === 'attention').length;
    const page = pageLine(s);
    const head: (readonly Seg[] | null)[] = [
      summarySegs(s, attention),
      [...projectsSegs(s), ui('   '), seg(filterLine(s), DIM)],
      page === null ? null : [seg(page, DIM)],
      opts.color ? null : [seg(markLegend(), DIM)],
    ];
    const shown = head.filter((l) => l !== null).slice(0, Math.max(1, height >> 1));
    shown.forEach((segs, i) => putSegs(frame, 1, top + i, segs, cols - 1));
    // A blank row under the summary when the list keeps enough room.
    const gap = height - shown.length > 8 ? 1 : 0;
    const listTop = top + shown.length + gap;
    const room = height - shown.length - gap;
    if (room <= 0) return;

    if (s.board === null) {
      // Before any answer the banner already says it is connecting.
      if (s.lastUpdatedAt === null && !s.stale) return;
      const why = s.stale ? 'No data for this view yet.' : 'Reading this view…';
      frame.put(1, listTop, truncate(uiText(why), cols - 1), DIM);
      return;
    }
    if (rows.length === 0) {
      frame.put(1, listTop, truncate(uiText('No tasks in this view.'), cols - 1), DIM);
      return;
    }
    drawList(frame, s, listTop, room, rows, opts.color);
  };
