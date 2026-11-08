/**
 * The frame shared by every screen: status bar, stale-data banner, key hints, scroll area, and the notice
 * under the minimum size. Pure: same state and size, same frame. The content of each screen comes in `body`,
 * so a resize can never lose a position kept in the state (EC-002).
 */
import { hintBar } from '../model/keymap.ts';
import {
  RECONNECT_ATTEMPTS,
  tooSmall,
  MIN_SIZE,
  type StopReason,
  type TuiState,
} from '../model/state.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import { Frame, type Style } from '../terminal/screen.ts';
import { displayWidth, truncate, truncateMiddle, wrap } from '../terminal/width.ts';
import { DIM, putSegs, seg, segsWidth, ui, type Seg } from './ink.ts';
import { BAD_STRONG, FOCUS, GOOD, WARN } from './theme.ts';

export function clockTime(at: number): string {
  const d = new Date(at);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const lastUpdated = (s: TuiState): string =>
  s.lastUpdatedAt === null ? 'never' : clockTime(s.lastUpdatedAt);

/**
 * What the connection state means for the data shown, one row each; empty while the data is current. Data
 * that may be old is never shown as current (SC-003). What to do comes on the first row, so a long reason
 * cannot push it off the screen.
 */
export function staleBanner(s: TuiState): readonly SafeText[] {
  const c = s.connection;
  const base = `Data may be out of date — last updated ${lastUpdated(s)}`;
  switch (c.kind) {
    case 'online':
      return s.stale ? [uiText(base)] : [];
    case 'connecting':
      return [uiText(s.stale ? `${base} — Connecting` : 'Connecting to the daemon')];
    case 'reconnecting':
      return [uiText(`${base} — Reconnecting (${c.attempt}/${RECONNECT_ATTEMPTS})`)];
    case 'waiting_retry':
      return [uiText(`${base} — Retry connection (R)`)];
    case 'stopped':
      return [uiText(`${base} — Retry connection (R)`)];
  }
}

const NEXT_STEP: Record<StopReason['kind'], string> = {
  actor: 'Next: set CUSR_ACTOR to owner or assistant (or unset it), then start cusr again.',
  unauthenticated: 'Next: install the same version of cusr and the daemon, then press R.',
  forbidden: 'Next: run as the owner (unset CUSR_ACTOR), or change the filter, then press R.',
  incompatible: 'Next: install the same version of cusr and the daemon, then press R.',
};

/** Wraps `text` in at most `rows` rows. Past that its middle goes, since a reason ends with its cause. */
function fitRows(text: SafeText, cols: number, rows: number): SafeText[] {
  for (let room = cols * rows; room > 0; room -= Math.max(1, cols >> 1)) {
    const wrapped = wrap(truncateMiddle(text, room), cols);
    if (wrapped.length <= rows) return wrapped;
  }
  return [truncateMiddle(text, cols)];
}

/**
 * What went wrong and what to do next, in rows of its own that wrap. It may use half of the rows between the
 * bars: the data under it still matters. Past that the middle of the reason is cut, so how it starts, its
 * cause at the end and the next step all stay.
 */
export function notices(s: TuiState, cols: number, room: number): SafeText[] {
  const c = s.connection;
  const blocks: { what: SafeText; next: string }[] = [];
  if (c.kind === 'stopped')
    blocks.push({
      what: joinSafe([uiText('Stopped: '), c.reason.message]),
      next: NEXT_STEP[c.reason.kind],
    });
  if (c.kind === 'waiting_retry')
    blocks.push({
      what: uiText('Cannot reach the daemon.'),
      next: 'Next: check that the daemon is running, then press R.',
    });
  if (s.health?.healthy === false && c.kind === 'online')
    blocks.push({
      what: joinSafe([uiText('Daemon unhealthy: '), s.health.reason ?? uiText('no reason given')]),
      // The daemon is healthy only while it can hand out work, so unhealthy means this (FR-010).
      next: 'New work is not being started. Next: run `cusr doctor` to see what to fix.',
    });
  return blocks.flatMap(({ what, next }) => {
    const nextRows = wrap(uiText(next), cols);
    const fits = Math.max(1, room - nextRows.length);
    return [...fitRows(what, cols, fits), ...nextRows];
  });
}

/** The task holding the slot by title when the board lists it, else by the start of its ID. */
function slotHolder(s: TuiState, id: string): SafeText {
  const listed = [...(s.board?.items ?? []), ...(s.board?.attention.items ?? [])];
  const task = listed.find((t) => t.task_id === id);
  return task === undefined ? uiText(id.slice(0, 8)) : truncate(task.title, 28);
}

/**
 * Short enough for 80 columns even with a busy slot and an unhealthy daemon; why it is unhealthy goes in
 * `notices` (FR-010). The time of the last update sits at the right edge and gives way first.
 */
function statusBar(s: TuiState, cols: number): Seg[] {
  // What was read before the connection went is no answer about now: nothing here may look fine (SC-003).
  const h = s.stale ? null : s.health;
  const daemon = h === null ? 'unknown' : h.healthy ? 'ok' : 'unhealthy';
  const dot: Style = h === null ? DIM : h.healthy ? GOOD : BAD_STRONG;
  const first = h?.slots[0];
  const slot =
    h === null
      ? uiText('-')
      : h.concurrency > 1
        ? uiText(`${h.slots.length}/${h.concurrency}`)
        : first === undefined
          ? uiText('free')
          : (first.reserved_at ?? null) === null
            ? slotHolder(s, first.holder_task_id)
            : (first.borrower_task_id ?? null) === null
              ? uiText('reserved')
              : joinSafe([slotHolder(s, first.borrower_task_id as string), uiText(' (borrowed)')]);
  const queue = s.stale ? '-' : String(s.board?.queue.length ?? h?.queue_length ?? '-');
  const project = s.filters.project === null ? uiText('all') : sanitize(s.filters.project);
  const right = ui(`updated: ${lastUpdated(s)} `, DIM);
  // Narrower terminals lose the brand and the wide separators before they lose any fact.
  for (const [wide, brand] of [
    [true, true],
    [false, true],
    [false, false],
  ] as const) {
    const bar = barSegs(dot, daemon, slot, queue, project, wide, brand);
    const gap = cols - segsWidth(bar) - displayWidth(right.text);
    if (gap >= 2) return [...bar, ui(' '.repeat(gap)), right];
  }
  // Tightest: plain facts in a row. The slot's title gives way before the project, which must show
  // (FR-008); the time stays (FR-009).
  const rest = `  queue: ${queue}  updated: ${lastUpdated(s)}  project: `;
  const fixed = ` daemon: ${daemon}  slot: ${rest}`;
  const slotRoom = Math.max(8, cols - displayWidth(fixed) - Math.min(displayWidth(project), 16));
  const facts = uiText(` daemon: ${daemon}  slot: ${truncate(slot, slotRoom)}${rest}`);
  return [seg(facts), seg(truncate(project, Math.max(1, cols - displayWidth(facts))))];
}

function barSegs(
  dot: Style,
  daemon: string,
  slot: SafeText,
  queue: string,
  project: SafeText,
  wide: boolean,
  brand: boolean,
): Seg[] {
  const sep = ui(wide ? '  │  ' : ' │ ', DIM);
  return [
    ...(brand ? [ui(' cuesura', FOCUS), ui(wide ? '   ' : ' ')] : [ui(' ')]),
    ui('● ', dot),
    ui(`daemon: ${daemon}`),
    sep,
    seg(joinSafe([uiText('slot: '), slot])),
    sep,
    ui(`queue: ${queue}`),
    sep,
    seg(joinSafe([uiText('project: '), project])),
  ];
}

/**
 * The first row to show so `selected` stays visible, moving as little as possible from `offset`. Computed from
 * the selection each time, so a new height keeps the same item on screen.
 */
export function scrollOffset(
  selected: number,
  count: number,
  height: number,
  offset: number,
): number {
  if (height <= 0 || count <= height) return 0;
  const last = count - height;
  const clamped = Math.min(Math.max(0, offset), last);
  if (selected < clamped) return Math.max(0, selected);
  if (selected >= clamped + height) return Math.min(last, selected - height + 1);
  return clamped;
}

/** Text of an area with rows of its own; rows outside it are dropped, never drawn over the frame. */
export type Body = (frame: Frame, top: number, height: number) => void;

export function renderFrame(
  s: TuiState,
  body: Body,
  opts: { readonly color: boolean; readonly colors256?: boolean },
): Frame {
  const { cols, rows } = s.size;
  const frame = new Frame(cols, rows, opts);
  if (tooSmall(s.size)) {
    const asks = wrap(
      uiText(
        `Resize your terminal to at least ${MIN_SIZE.cols}×${MIN_SIZE.rows}. Current size: ${cols}×${rows}.`,
      ),
      cols,
    );
    asks.forEach((row, i) => frame.put(0, i, row));
    if (rows > asks.length)
      frame.put(0, asks.length, truncate(uiText('q quit'), cols), {
        dim: true,
      });
    return frame;
  }
  putSegs(frame, 0, 0, statusBar(s, cols), cols);
  let top = 1;
  const room = Math.floor((rows - 2) / 2);
  for (const line of [...staleBanner(s), ...notices(s, cols, room)]) {
    frame.put(0, top, truncate(line, cols), WARN);
    top += 1;
  }
  const hints = hintBar(s, cols).split('  ');
  putSegs(
    frame,
    0,
    rows - 1,
    hints.flatMap((hint, i) => {
      const space = hint.indexOf(' ');
      return [
        ...(i === 0 ? [] : [ui('  ')]),
        ui(space < 0 ? hint : hint.slice(0, space), FOCUS),
        ui(space < 0 ? '' : hint.slice(space), DIM),
      ];
    }),
    cols,
  );
  body(frame, top, rows - top - 1);
  return frame;
}
