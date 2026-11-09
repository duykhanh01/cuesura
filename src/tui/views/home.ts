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
import { QUEUE_TARGET } from '../client/mutations.ts';
import { mutationLine } from './actions.ts';
import { pausedBy } from './dialog.ts';
import { filtered, filterLine } from './filters.ts';
import { BOLD, DIM, fg, putSegs, ruleHeading, seg, segsWidth, ui, type Seg } from './ink.ts';
import { clockTime, type Body } from './layout.ts';
import { dots, DOTS_WIDTH, stepper, stepperRow } from './stepper.ts';
import { BAD, FOCUS, NOTICE, WARN } from './theme.ts';

const STATUS_WORD: Readonly<Record<TaskStatus, string>> = {
  PENDING: 'pending',
  READY: 'ready',
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** With one project in scope, naming it on every row says nothing. */
const oneProject = (s: TuiState): boolean => s.projects?.length === 1;

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

function projectLine(s: TuiState): Seg[] | null {
  const projects = oneProject(s) ? null : projectsSegs(s);
  if (!filtered(s)) return projects;
  const filter = seg(filterLine(s), DIM);
  return projects === null ? [filter] : [...projects, ui('   '), filter];
}

/**
 * `▲ 2 need you   ▶ 3 running …`: what the daemon counted, each status with its mark and colour. A task that
 * needs the user counts there and not again under its status, so the figures add up to the tasks listed.
 */
function summarySegs(s: TuiState, attention: number): Seg[] | null {
  if (s.board === null) return null;
  const counts = s.board.counts.by_status;
  const listed = s.board.attention.items;
  const out: Seg[] = [];
  if (attention > 0) {
    const more = s.board.attention.truncated ? '+' : '';
    out.push(ui(`▲ ${attention}${more} need you`, WARN));
  }
  for (const status of TASK_STATUSES) {
    const n = (counts[status] ?? 0) - listed.filter((t) => t.status === status).length;
    if (n <= 0) continue;
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

/** The queue pause, which holds every task not started yet, and the latest write on the queue. */
function queueLines(s: TuiState): Seg[][] {
  const out: Seg[][] = [];
  const p = s.queuePaused;
  if (p !== null)
    out.push([
      ui('‖ Queue paused: ', WARN),
      seg(p.reason),
      seg(joinSafe([uiText(' · by '), p.by, uiText(` at ${clockTime(p.at)} · p to resume`)]), DIM),
    ]);
  const m = s.mutations.get(QUEUE_TARGET);
  const line = m === undefined || m.state === 'accepted' ? null : mutationLine(m);
  if (line !== null && m !== undefined)
    out.push([ui(`Queue (${m.command.kind}): `, DIM), ui(line.text, line.style)]);
  return out;
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
      segs: ruleHeading(`Needs you (${attention}${more})`, cols, WARN),
    });
  }
  let inTasks = false;
  rows.forEach((row, i) => {
    if (row.kind === 'task' && !inTasks) {
      inTasks = true;
      gap();
      lines.push({
        kind: 'static',
        segs: ruleHeading('Tasks', cols, FOCUS),
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
const PROJECT_GAP = 2;

const projectWidth = (c: Columns): number => (c.project === 0 ? 0 : c.project + PROJECT_GAP);

/** Selected row: faint or plain text takes the selection style; yellow and red keep their meaning. */
const highlight = (segs: readonly Seg[]): Seg[] =>
  segs.map((g) => (g.style?.fg === 'yellow' || g.style?.fg === 'red' ? g : { ...g, style: FOCUS }));

const TITLE_MIN = 14;
/** Enough for a status and a mode, such as `Cancelled · full-review`. */
const DOING_MIN = 24;

/**
 * How the title and the activity share `room`. Each gets its longest text when both fit, so a wide terminal
 * cuts nothing; short of room the activity gives way first, down to `DOING_MIN`, then the title.
 */
export function shareColumns(
  room: number,
  want: { readonly title: number; readonly doing: number },
): { readonly title: number; readonly doing: number } {
  const title = Math.max(TITLE_MIN, want.title);
  if (title + want.doing <= room) return { title, doing: room - title };
  const doing = Math.min(want.doing, Math.max(DOING_MIN, Math.round(room * 0.4)));
  const cut = Math.max(TITLE_MIN, Math.min(title, room - doing));
  return { title: cut, doing: Math.max(8, room - cut) };
}

/** The time column fits the longest time shown, so `unavailable` reads whole and `5s` costs little. */
function columns(s: TuiState, cols: number, rows: readonly HomeRow[]): Columns {
  const tasks = rows.filter((r): r is TaskRow => r.kind !== 'finished_toggle');
  const longest = (width: (r: TaskRow) => number, floor: number): number =>
    tasks.reduce((n, r) => Math.max(n, width(r)), floor);
  const time = longest((r) => displayWidth(timeInStatus(r.task, s.lastUpdatedAt)), 'Time'.length);
  // Selector and mark, then the gaps between columns and the time at the edge.
  const fixed = TITLE_X + 2 + 2 + DOTS_WIDTH + 2 + 2 + 1 + time;
  const room = Math.max(24, cols - fixed + (oneProject(s) ? PROJECT_GAP : 0));
  const project = oneProject(s)
    ? 0
    : Math.min(
        longest((r) => displayWidth(r.task.project), 7),
        14,
        Math.floor(room / 5),
      );
  const share = shareColumns(room - project, {
    title: longest((r) => displayWidth(r.task.title), 0),
    doing: longest((r) => segsWidth(doingSegs(r)), 0),
  });
  return { ...share, project, time };
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
  // A pause holds a task whatever else it waits on; a pause alone already reads `Paused`.
  const paused = (task.paused ?? null) !== null && task.wait_code !== 'paused';
  const lead = paused ? [ui('Paused · ', NOTICE)] : [];
  return [...lead, ...ownDoingSegs(row)];
}

function ownDoingSegs(row: TaskRow): Seg[] {
  const task = row.task;
  const action = actionOf(row);
  if (action !== null) return [seg(joinSafe([uiText('→ '), action]), NOTICE)];
  const tail = extraSegs(task);
  const { status } = task;
  const style: Style =
    status === 'FAILED'
      ? BAD
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
  return TITLE_X + c.title + 2 + projectWidth(c) + DOTS_WIDTH + 2;
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
  if (selected) frame.put(0, y, uiText('›'), FOCUS);
  const { mark, color } = statusGlyph(task.status);
  frame.put(2, y, uiText(mark), fg(color, { bold: true }));
  let x = TITLE_X;
  const titleStyle: Style = selected
    ? FOCUS
    : isTerminal(task.status)
      ? DIM
      : row.kind === 'attention'
        ? BOLD
        : {};
  frame.put(x, y, truncate(task.title, c.title), titleStyle);
  x += c.title + 2;
  if (c.project > 0)
    frame.put(x, y, truncate(sanitize(task.project), c.project), selected ? FOCUS : DIM);
  x += projectWidth(c);
  const stages = rowStages(task);
  if (stages !== null) putSegs(frame, x, y, dots(stages, task.status, useColor), DOTS_WIDTH);
  x += DOTS_WIDTH + 2;
  putSegs(frame, x, y, selected ? highlight(doingSegs(row)) : doingSegs(row), c.doing);
  const time = truncate(timeInStatus(task, s.lastUpdatedAt), c.time);
  frame.put(cols - displayWidth(time) - 1, y, time, selected ? FOCUS : DIM);
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
    'Project'.slice(0, c.project).padEnd(projectWidth(c)),
    'Stages'.padEnd(DOTS_WIDTH + 2),
    'Now',
  ].join('');
  const right = 'Time';
  const gap = cols - displayWidth(heads) - displayWidth(right) - 1;
  return [ui(gap > 0 ? `${heads}${' '.repeat(gap)}${right}` : heads, DIM)];
}

/** The selected task's stages spelled out, so the dots of every row can be read against them. */
function selectionStages(s: TuiState, row: TaskRow): Seg[] | null {
  const stages = rowStages(row.task);
  if (stages === null) return null;
  const path = [ui(' '), ...stepper(stages, row.task.status)];
  if (segsWidth(path) + 8 <= s.size.cols) return [ui(' Stages ', DIM), ...path];
  return [ui(' '), ...stepperRow(stages, row.task.status, s.size.cols - 2)];
}

/**
 * Under the list, the selected task in full: its whole title, which a narrow column cuts, its stages, and
 * its whole ID, since `cusr` takes no shortened form. Empty on the Finished toggle and on a
 * screen too short to spare the rows.
 */
function selectionFooter(s: TuiState, row: HomeRow | undefined, space: number): Seg[][] {
  if (row === undefined || row.kind === 'finished_toggle' || space <= 8) return [];
  const stages = selectionStages(s, row);
  const title = [ui(' Task   ', DIM), ui(' '), seg(row.task.title, BOLD)];
  const id = [ui(' ID     ', DIM), ui(' '), seg(sanitize(row.task.task_id), DIM)];
  const p = row.task.paused ?? null;
  const paused = p === null ? [] : [[ui(' Paused ', DIM), ui(' '), seg(pausedBy(p), NOTICE)]];
  return [
    [ui('─'.repeat(s.size.cols), DIM)],
    title,
    id,
    ...paused,
    ...(stages === null ? [] : [stages]),
  ];
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
  const footer = selectionFooter(s, rows[selected], space);
  const height = space - footer.length;
  footer.forEach((line, i) => putSegs(frame, 0, top + height + i, line, cols));
  const c = columns(s, cols, rows);
  const lines: Line[] = [
    { kind: 'static', segs: columnHeads(c, cols) },
    // The first entry may be a heading or the Finished toggle; the gap keeps the list's one rhythm.
    BLANK,
    ...listLines(s, rows, cols),
  ];
  // A list longer than the screen gives up its last row to say so.
  const room = lines.length > height ? Math.max(1, height - 1) : height;
  const offset = firstLine(lines, selected, room);
  const below = lines
    .slice(offset + room)
    .filter((l) => l.kind === 'task' || l.kind === 'toggle').length;
  const shown = lines.slice(offset, offset + room);
  // A heading with nothing under it is not worth a row.
  while (below > 0 && shown.at(-1)?.kind === 'static') shown.pop();
  if (below > 0) frame.put(2, top + height - 1, uiText(`↓ ${below} more`), DIM);
  shown.forEach((line, i) => {
    const y = top + i;
    if (line.kind === 'static') putSegs(frame, 0, y, line.segs, cols);
    else if (line.kind === 'detail')
      putSegs(frame, doingX(c), y, detailSegs(line.item), cols - doingX(c) - 1);
    else if (line.kind === 'toggle') {
      const on = line.row === selected;
      if (on) frame.put(0, y, uiText('›'), FOCUS);
      frame.put(2, y, truncate(line.text, cols - 2), on ? FOCUS : DIM);
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
      ...queueLines(s),
      summarySegs(s, attention),
      // With no filter on, the status bar already says `project: all` and the key bar offers `f`.
      projectLine(s),
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
