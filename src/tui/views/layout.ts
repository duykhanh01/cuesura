/**
 * The frame shared by every screen: status bar, stale-data banner, key hints, scroll area, and the notice
 * under the minimum size. Pure: same state and size, same frame. The content of each screen comes in `body`,
 * so a resize can never lose a position kept in the state (EC-002).
 */
import {
  RECONNECT_ATTEMPTS,
  tooSmall,
  MIN_SIZE,
  currentScreen,
  type StopReason,
  type TuiState,
} from '../model/state.ts';
import {
  joinSafe,
  sanitize,
  uiText,
  type SafeText,
} from '../terminal/safe-text.ts';
import { Frame } from '../terminal/screen.ts';
import {
  displayWidth,
  padEnd,
  truncate,
  truncateMiddle,
  wrap,
} from '../terminal/width.ts';

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
      return [
        uiText(s.stale ? `${base} — Connecting` : 'Connecting to the daemon'),
      ];
    case 'reconnecting':
      return [
        uiText(`${base} — Reconnecting (${c.attempt}/${RECONNECT_ATTEMPTS})`),
      ];
    case 'waiting_retry':
      return [uiText(`${base} — Retry connection (R)`)];
    case 'stopped':
      return [uiText(`${base} — Retry connection (R)`)];
  }
}

const NEXT_STEP: Record<StopReason['kind'], string> = {
  token: 'Next: fix the token file or CUSR_TOKEN_FILE, then press R.',
  unauthenticated:
    'Next: use a valid token (CUSR_TOKEN_FILE or the owner token), then press R.',
  incompatible:
    'Next: install the same version of cusr and the daemon, then press R.',
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
      what: joinSafe([
        uiText('Daemon unhealthy: '),
        s.health.reason ?? uiText('no reason given'),
      ]),
      next: 'Next: run `cusr doctor` to see what to fix.',
    });
  return blocks.flatMap(({ what, next }) => {
    const nextRows = wrap(uiText(next), cols);
    const fits = Math.max(1, room - nextRows.length);
    return [...fitRows(what, cols, fits), ...nextRows];
  });
}

/**
 * Short enough for 80 columns even with a busy slot and an unhealthy daemon; why it is unhealthy goes in
 * `notices` (FR-010). Only the project name, the one part of any length, gives way.
 */
function statusBar(s: TuiState, cols: number): SafeText {
  const h = s.health;
  const daemon = h === null ? 'unknown' : h.healthy ? 'ok' : 'unhealthy';
  const slot =
    h === null
      ? '-'
      : h.slot === null
        ? 'free'
        : h.slot.holder_task_id.slice(0, 8);
  const facts = uiText(
    [
      `daemon: ${daemon}`,
      `slot: ${slot}`,
      `queue: ${s.board?.queue.length ?? h?.queue_length ?? '-'}`,
      `updated: ${lastUpdated(s)}`,
      'project: ',
    ].join('  '),
  );
  const project =
    s.filters.project === null ? uiText('all') : sanitize(s.filters.project);
  return joinSafe([facts, truncate(project, cols - displayWidth(facts))]);
}

function hints(s: TuiState): SafeText {
  const keys = ['q quit', '? help'];
  if (currentScreen(s) !== 'home') keys.unshift('Esc back');
  if (s.connection.kind === 'waiting_retry' || s.connection.kind === 'stopped')
    keys.push('R retry connection');
  return uiText(keys.join('  '));
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
  if (selected >= clamped + height)
    return Math.min(last, selected - height + 1);
  return clamped;
}

/** Text of an area with rows of its own; rows outside it are dropped, never drawn over the frame. */
export type Body = (frame: Frame, top: number, height: number) => void;

export function renderFrame(
  s: TuiState,
  body: Body,
  opts: { color: boolean },
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
  frame.put(0, 0, padEnd(truncate(statusBar(s, cols), cols), cols), {
    inverse: true,
  });
  let top = 1;
  const room = Math.floor((rows - 2) / 2);
  for (const line of [...staleBanner(s), ...notices(s, cols, room)]) {
    frame.put(0, top, truncate(line, cols), { fg: 'yellow', bold: true });
    top += 1;
  }
  frame.put(0, rows - 1, truncate(hints(s), cols), { dim: true });
  body(frame, top, rows - top - 1);
  return frame;
}
