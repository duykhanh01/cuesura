/**
 * The gates on the Logs screen: each round, the gates of the round chosen, and part of the log of the gate
 * chosen. A gate's log is finished once it can be read, so unlike the agent log this is a window on a file:
 * it holds at most `GATE_WINDOW_BYTES`, moved by byte offset as the reader scrolls past either end.
 */
import { LOG_POLL_INTERVAL_MS } from '../client/refresh.ts';
import type { PortResult } from '../client/daemon-port.ts';
import type { TaskGateLog, TaskGates } from '../client/schemas.ts';
import { cleanLog, type SafeText } from '../terminal/safe-text.ts';
import { wrap } from '../terminal/width.ts';
import type { Command } from './keymap.ts';

/** Where failures are reported is the end of a log; this much is on screen as soon as it opens. */
const GATE_PAGE_BYTES = 256 * 1024;
const GATE_WINDOW_BYTES = 1024 * 1024;
/** The daemon reads no less at a time. */
const GATE_MIN_READ_BYTES = 1024;
/** Gates listed beside the log before the list scrolls with the choice. */
const GATE_LIST_ROWS = 6;
const GATE_LOG_MIN_ROWS = 3;

/** How long a running task may stay silent before the screen mentions it, and then calls it stuck. */
export const QUIET_MS = 60_000;
export const STUCK_MS = 5 * 60_000;

export const GATES_STOP = 'gates';

export type GateRound = TaskGates['rounds'][number];
export type GateRow = GateRound['gates'][number];

export type GateLogRead =
  | { readonly gate: string; readonly round: number; readonly tail: true; readonly limit: number }
  | {
      readonly gate: string;
      readonly round: number;
      readonly offset: number;
      readonly limit: number;
    };

/** What of the log is held. `offset`/`end` are bytes of the file, `text` the same bytes as text. */
type GateWindow = {
  readonly text: string;
  readonly offset: number;
  readonly end: number;
  readonly size: number;
};

export type GateLogView = {
  readonly gate: string;
  readonly round: number;
  readonly state: 'reading' | 'available' | 'expired' | 'missing';
  readonly window: GateWindow | null;
  /** Bytes to read next, or null when what is wanted is held. */
  readonly want: GateLogRead | null;
};

export type GatesView = {
  readonly generation: number;
  /** Live keeps to the newest round; choosing or scrolling up holds the place. */
  readonly mode: 'live' | 'paused';
  /** Paused by scrolling up rather than on asking: coming back to the end follows again. */
  readonly scrolledAway: boolean;
  readonly rounds: TaskGates['rounds'] | null;
  readonly running: TaskGates['running'];
  readonly round: number | null;
  readonly gate: string | null;
  readonly log: GateLogView | null;
  /** The first row on screen; `null` is the end of the log. */
  readonly top: number | null;
  readonly error: SafeText | null;
  readonly readAt: number | null;
};

export function openGates(before: GatesView | null): GatesView {
  return {
    generation: (before?.generation ?? 0) + 1,
    mode: 'live',
    scrolledAway: false,
    rounds: null,
    running: null,
    round: null,
    gate: null,
    log: null,
    top: null,
    error: null,
    readAt: null,
  };
}

export const roundOf = (v: GatesView): GateRound | null =>
  v.rounds?.find((r) => r.round === v.round) ?? null;

export const chosenGate = (v: GatesView): GateRow | null =>
  roundOf(v)?.gates.find((g) => g.gate === v.gate) ?? null;

const tailRead = (gate: string, round: number): GateLogRead => ({
  gate,
  round,
  tail: true,
  limit: GATE_PAGE_BYTES,
});

/** The log of what is now chosen; the same gate of the same round keeps what was read of it. */
function choose(v: GatesView, round: number | null, gate: string | null): GatesView {
  const log =
    round === null || gate === null
      ? null
      : v.log?.round === round && v.log.gate === gate
        ? v.log
        : ({
            gate,
            round,
            state: 'reading',
            window: null,
            want: tailRead(gate, round),
          } satisfies GateLogView);
  return { ...v, round, gate, log, top: log === v.log ? v.top : null };
}

/** A failed gate is why anyone comes here. */
const firstOfInterest = (round: GateRound | null): string | null =>
  (round?.gates.find((g) => !g.passed) ?? round?.gates[0])?.gate ?? null;

export function gatesDue(v: GatesView, now: number): boolean {
  return v.readAt === null || now - v.readAt >= LOG_POLL_INTERVAL_MS;
}

export function gateLogDue(v: GatesView, now: number): GateLogRead | null {
  const want = v.log?.want ?? null;
  // A read that failed waits its turn, as any other does.
  if (want === null || (v.error !== null && !gatesDue(v, now))) return null;
  return want;
}

export function onGatesRead(v: GatesView, result: PortResult<TaskGates>, at: number): GatesView {
  if (!result.ok) return { ...v, error: result.error.message, readAt: at };
  const { rounds, running } = result.value;
  const next = { ...v, rounds, running, error: null, readAt: at };
  const latest = rounds.at(-1) ?? null;
  if (v.mode === 'live' || v.round === null) {
    const moved = latest?.round !== v.round;
    return choose(
      next,
      latest?.round ?? null,
      moved ? firstOfInterest(latest) : (v.gate ?? firstOfInterest(latest)),
    );
  }
  return next;
}

const fromBytes = (b: Buffer): string => b.toString('utf8');

/** `at`, moved by `step` until it is not inside a character; a split one would decode to other bytes. */
function onCharacter(bytes: Buffer, at: number, step: 1 | -1): number {
  let i = at;
  while (((bytes[i] ?? 0) & 0xc0) === 0x80) i += step;
  return i;
}

/** Keeps the window within its cap, by dropping whole lines from the end the reader moved away from. */
function capped(w: GateWindow, keep: 'start' | 'end'): GateWindow {
  const bytes = Buffer.from(w.text, 'utf8');
  if (bytes.length <= GATE_WINDOW_BYTES) return w;
  if (keep === 'start') {
    const part = bytes.subarray(0, onCharacter(bytes, GATE_WINDOW_BYTES, -1));
    const line = part.lastIndexOf(0x0a);
    const kept = line < 0 ? part : part.subarray(0, line + 1);
    return { ...w, text: fromBytes(kept), end: w.offset + kept.length };
  }
  const part = bytes.subarray(onCharacter(bytes, bytes.length - GATE_WINDOW_BYTES, 1));
  const line = part.indexOf(0x0a);
  const kept = line < 0 ? part : part.subarray(line + 1);
  return { ...w, text: fromBytes(kept), offset: w.end - kept.length };
}

function merged(held: GateWindow | null, r: TaskGateLog): GateWindow | null {
  if (r.text === undefined || r.offset === undefined || r.next_offset === undefined) return held;
  const page = {
    text: r.text,
    offset: r.offset,
    end: r.next_offset,
    size: r.size ?? r.next_offset,
  };
  if (held === null) return capped(page, 'end');
  if (page.end <= held.offset || page.offset < held.offset) {
    // A read of less than the daemon's least can reach into what is held.
    const bytes = Buffer.from(page.text, 'utf8');
    const before = bytes.subarray(0, Math.max(0, held.offset - page.offset));
    return capped(
      { ...held, text: `${fromBytes(before)}${held.text}`, offset: page.offset },
      'start',
    );
  }
  return capped({ ...held, text: `${held.text}${page.text}`, end: page.end }, 'end');
}

const rowsOfText = (text: string, cols: number): number =>
  wrap(cleanLog(text.replace(/\n$/, '')), cols).length;

/** The screen's first row once text came in above it or left from above it, so the place holds. */
function shifted(
  top: number,
  before: GateLogView,
  after: GateLogView,
  page: string,
  cols: number,
): number {
  const was = before.window;
  const now = after.window;
  if (was === null || now === null) return top;
  if (now.offset < was.offset) return top + rowsOfText(page, cols);
  const dropped =
    gateRows(before, cols).length + rowsOfText(page, cols) - gateRows(after, cols).length;
  return Math.max(0, top - Math.max(0, dropped));
}

const sameRead = (a: GateLogRead, b: GateLogRead): boolean =>
  a.gate === b.gate &&
  a.round === b.round &&
  a.limit === b.limit &&
  ('tail' in a ? 'tail' in b : 'offset' in b && a.offset === b.offset);

export function onGateLogRead(
  v: GatesView,
  request: GateLogRead,
  result: PortResult<TaskGateLog>,
  at: number,
  cols: number,
): GatesView {
  const log = v.log;
  // Compared by value: scrolling on asks for the same bytes again, and that answer is still good.
  if (log?.want == null || !sameRead(log.want, request)) return v;
  if (!result.ok) return { ...v, error: result.error.message, readAt: at };
  const r = result.value;
  if (r.state !== 'available')
    return { ...v, error: null, log: { ...log, state: r.state, window: null, want: null } };
  const window = merged(log.window, r);
  const next: GateLogView = { ...log, state: 'available', window, want: null };
  const top = v.top === null ? null : shifted(v.top, log, next, r.text ?? '', cols);
  return { ...v, error: null, log: next, top };
}

const rowsOfLog = new WeakMap<GateLogView, { cols: number; rows: readonly SafeText[] }>();

/** The rows of what is held, wrapped once per width: only a new window or a resize costs this. */
export function gateRows(log: GateLogView, cols: number): readonly SafeText[] {
  const known = rowsOfLog.get(log);
  if (known?.cols === cols) return known.rows;
  const text = (log.window?.text ?? '').replace(/\n$/, '');
  const rows = text === '' ? [] : wrap(cleanLog(text), cols);
  rowsOfLog.set(log, { cols, rows });
  return rows;
}

/** Rows the list of gates takes, the heading of the log included. Narrow, the list is one row. */
export function gateListRows(v: GatesView, wide: boolean): number {
  const gates = (roundOf(v)?.gates.length ?? 0) + (v.running === null ? 0 : 1);
  return (wide ? Math.min(GATE_LIST_ROWS, Math.max(1, gates)) : 1) + 1;
}

/** Rows of log on screen, of `height` rows for the list and the log together. */
export function gateLogRows(v: GatesView, height: number, wide: boolean): number {
  return Math.max(GATE_LOG_MIN_ROWS, height - gateListRows(v, wide));
}

function firstShown(v: GatesView, rows: number, height: number): number {
  const last = Math.max(0, rows - height);
  return v.top === null ? last : Math.min(v.top, last);
}

export function visibleGateRows(v: GatesView, cols: number, height: number): readonly SafeText[] {
  if (v.log === null) return [];
  const rows = gateRows(v.log, cols);
  const first = firstShown(v, rows.length, height);
  return rows.slice(first, first + height);
}

/** Rows of what is held below the screen, and bytes of the log past what is held. */
export function gateBelow(
  v: GatesView,
  cols: number,
  height: number,
): { readonly rows: number; readonly bytes: number } {
  if (v.log === null) return { rows: 0, bytes: 0 };
  const rows = gateRows(v.log, cols);
  const w = v.log.window;
  return {
    rows: Math.max(0, rows.length - firstShown(v, rows.length, height) - height),
    bytes: w === null ? 0 : w.size - w.end,
  };
}

/** Back at the end: a place only scrolling held goes on following. */
const resumed = (v: GatesView): GatesView['mode'] => (v.scrolledAway ? 'live' : v.mode);

/** Scrolling up holds the place; a pause already asked for stays one. */
const hold = (v: GatesView): GatesView =>
  v.mode === 'live' ? { ...v, mode: 'paused', scrolledAway: true } : v;

function scroll(v: GatesView, cols: number, height: number, delta: number): GatesView {
  const log = v.log;
  if (log === null) return v;
  const rows = gateRows(log, cols).length;
  const last = Math.max(0, rows - height);
  const from = firstShown(v, rows, height);
  const to = from + delta;
  const w = log.window;
  if (to < 0 && w !== null && w.offset > 0) {
    const offset = Math.max(0, w.offset - GATE_PAGE_BYTES);
    const limit = Math.max(GATE_MIN_READ_BYTES, w.offset - offset);
    const want = { gate: log.gate, round: log.round, offset, limit };
    return { ...hold(v), top: 0, log: { ...log, want } };
  }
  if (to > last && w !== null && w.end < w.size) {
    const want = { gate: log.gate, round: log.round, offset: w.end, limit: GATE_PAGE_BYTES };
    return { ...v, top: last, log: { ...log, want } };
  }
  const place = Math.min(Math.max(0, to), last);
  if (place >= last && (w === null || w.end >= w.size))
    return { ...v, top: null, scrolledAway: false, mode: resumed(v) };
  return { ...hold(v), top: place };
}

/** To the very end or start of the log, not only of what is held. */
function jump(v: GatesView, to: 'top' | 'end'): GatesView {
  const log = v.log;
  if (log === null) return v;
  const w = log.window;
  if (to === 'end') {
    const atEnd = { ...v, top: null, scrolledAway: false, mode: resumed(v) };
    if (w === null || w.end >= w.size) return atEnd;
    return { ...atEnd, log: { ...log, window: null, want: tailRead(log.gate, log.round) } };
  }
  if (w === null || w.offset === 0) return { ...v, mode: 'paused', top: 0 };
  const want = { gate: log.gate, round: log.round, offset: 0, limit: GATE_PAGE_BYTES };
  return { ...v, mode: 'paused', top: 0, log: { ...log, window: null, want } };
}

function nextGate(v: GatesView, direction: 1 | -1): GatesView {
  const gates = roundOf(v)?.gates ?? [];
  if (gates.length === 0) return v;
  const at = gates.findIndex((g) => g.gate === v.gate);
  const next = gates[(at + direction + gates.length) % gates.length] as GateRow;
  return choose({ ...v, mode: 'paused', scrolledAway: false }, v.round, next.gate);
}

function nextRound(v: GatesView, direction: 1 | -1): GatesView {
  const rounds = v.rounds ?? [];
  const at = rounds.findIndex((r) => r.round === v.round);
  const next = rounds[at + direction];
  if (next === undefined) return v;
  const same = next.gates.some((g) => g.gate === v.gate);
  return choose(
    { ...v, mode: 'paused', scrolledAway: false },
    next.round,
    same ? v.gate : firstOfInterest(next),
  );
}

/** Live again, on the newest round, as the next list will show it. */
function followGates(v: GatesView): GatesView {
  const latest = v.rounds?.at(-1) ?? null;
  return choose(
    { ...v, mode: 'live', scrolledAway: false, top: null },
    latest?.round ?? null,
    firstOfInterest(latest),
  );
}

/** `null`: not a command of the gates. */
export function gatesCommand(
  v: GatesView,
  command: Command,
  cols: number,
  height: number,
): GatesView | null {
  switch (command) {
    case 'up':
      return scroll(v, cols, height, -1);
    case 'down':
      return scroll(v, cols, height, 1);
    case 'page_up':
      return scroll(v, cols, height, -Math.max(1, height - 1));
    case 'page_down':
      return scroll(v, cols, height, Math.max(1, height - 1));
    case 'top':
      return jump(v, 'top');
    case 'end':
      return jump(v, 'end');
    case 'pause':
      return v.mode === 'live' ? { ...v, mode: 'paused', scrolledAway: false } : followGates(v);
    case 'next_gate':
      return nextGate(v, 1);
    case 'previous_gate':
      return nextGate(v, -1);
    case 'next_round':
      return nextRound(v, 1);
    case 'previous_round':
      return nextRound(v, -1);
    default:
      return null;
  }
}
