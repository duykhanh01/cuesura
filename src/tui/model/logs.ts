/**
 * The Logs screen's state (data-model.md "Trạng thái log", FR-014, FR-039, EC-011). It holds a window over the
 * task's log, never more than the cap: what leaves it is read again by position, because the daemon's cursor
 * does not change through rotation or restart. The place being read is kept by record, not by row, so
 * neither a resize nor new records can move it.
 */
import { LOG_POLL_INTERVAL_MS } from '../client/refresh.ts';
import type { TaskLogs } from '../client/schemas.ts';
import { joinSafe, sanitize, sanitizeLines, uiText, type SafeText } from '../terminal/safe-text.ts';
import { displayWidth, wrap } from '../terminal/width.ts';
import { stepWords } from './activity.ts';
import { describeRecord, type Tone } from './log-text.ts';
import type { Seg } from '../views/ink.ts';
import { markdownRows } from '../views/markdown.ts';

export const LOG_BUFFER_RECORDS = 5_000;
export const LOG_BUFFER_BYTES = 8 * 1024 * 1024;
/** The daemon's page; also how far back one reading of older records reaches. */
export const LOG_PAGE_RECORDS = 200;
/** The progress column beside the log, when the terminal is wide enough for both. */
export const PROGRESS_PANE = 30;
const TWO_COLUMNS_FROM = 100;

/** Columns of the log: what is left of the terminal beside the progress column and its rule. */
export function logColumns(cols: number): {
  readonly pane: number;
  readonly log: number;
} {
  return cols >= TWO_COLUMNS_FROM
    ? { pane: PROGRESS_PANE, log: cols - PROGRESS_PANE - 2 }
    : { pane: 0, log: cols };
}

/** Title, what is being followed, and one row for news. */
export const LOG_HEADER_ROWS = 3;
/** A record can be 256 KiB on one line; drawing that on every frame would hold the keys up (EC-011). */
const LOG_TEXT_CHARS = 16 * 1024;
const ENTRY_OVERHEAD_BYTES = 128;

/** One line a record reads as: a short label, what it says, and its tone. */
export type LogLine = {
  readonly label: SafeText;
  readonly body: SafeText;
  readonly tone: Tone;
};

export type LogEntry = {
  readonly seq: number;
  readonly attemptId: string | null;
  /** `null` for a gap too, which says nothing about a step. */
  readonly step: SafeText | null;
  readonly gap: boolean;
  /** `HH:MM:SS`, empty for a gap. */
  readonly time: SafeText;
  readonly lines: readonly LogLine[];
  /** Everything the entry says, on one line: what a search or a test compares. */
  readonly text: SafeText;
  readonly bytes: number;
};

type Older = {
  /** Where this reading started, and where the buffer starts. */
  readonly after: number;
  readonly upTo: number;
  readonly cursor: number;
  readonly collected: readonly LogEntry[];
};

export type LogState = {
  readonly taskId: string;
  readonly title: SafeText;
  /** See `TuiState.screenSession`. */
  readonly session: number;
  /** Bumped when what is being read changes, so an answer to the former question is not taken for this one. */
  readonly generation: number;
  readonly mode: 'live' | 'paused';
  readonly attemptFilter: string | null;
  readonly buffer: readonly LogEntry[];
  readonly bufferBytes: number;
  /** The cursor just before the buffer's first record; above 0 means earlier records can be read again. */
  readonly windowStart: number;
  /** Where the next forward read starts. */
  readonly nextCursor: number;
  /** While an attempt is being read: where following the whole log goes on from. */
  readonly resumeCursor: number | null;
  readonly newActivity: boolean;
  /** The first row on screen while paused; `null` is the top of the buffer. */
  readonly anchor: { readonly seq: number; readonly row: number } | null;
  /** The first reads of an attempt, until it is all here or the buffer is full. */
  readonly filling: boolean;
  /** Records past the buffer's end were dropped or never fetched; `wantForward` asks for them. */
  readonly moreForward: boolean;
  readonly wantForward: boolean;
  readonly wantOlder: boolean;
  readonly older: Older | null;
  /** The task has ended and everything was read: there is nothing left to ask for. */
  readonly complete: boolean;
  readonly error: SafeText | null;
  readonly lastReadAt: number | null;
  /** The attempt chooser is open at this row. */
  readonly picker: number | null;
};

/**
 * Enough of an attempt's ID to tell it from the task's others. Its end, because IDs are UUIDv7: their start is
 * the time, the same for attempts made within a minute of each other.
 */
export const shortAttempt = (id: string): SafeText => sanitize(id.slice(-8));

export function initialLogs(taskId: string, title: SafeText, session: number): LogState {
  return {
    taskId,
    title,
    session,
    generation: 0,
    mode: 'live',
    attemptFilter: null,
    buffer: [],
    bufferBytes: 0,
    windowStart: 0,
    nextCursor: 0,
    resumeCursor: null,
    newActivity: false,
    anchor: null,
    filling: false,
    moreForward: false,
    wantForward: false,
    wantOlder: false,
    older: null,
    complete: false,
    error: null,
    lastReadAt: null,
    picker: null,
  };
}

/** `HH:MM:SS` of an ISO time, or the value as it came: nothing is assumed of what the daemon sends. */
function shortTime(at: SafeText): SafeText {
  const m = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)/.exec(at);
  return m === null ? at : sanitize(m[1] as string);
}

function capped(whole: string): SafeText {
  if (whole.length <= LOG_TEXT_CHARS) return sanitizeLines(whole);
  return joinSafe([
    sanitizeLines(whole.slice(0, LOG_TEXT_CHARS)),
    uiText(`… ${whole.length - LOG_TEXT_CHARS} more characters: see cusr task logs`),
  ]);
}

/** The record as a person reads it; `null` for bookkeeping with nothing to say (see `log-text.ts`). */
export function toEntry(record: TaskLogs['records'][number]): LogEntry | null {
  if ('gap' in record) {
    const { records, reason } = record.gap as {
      readonly records: number;
      readonly reason: SafeText;
    };
    const text = joinSafe([
      uiText(
        records === 0
          ? 'Log temporarily unavailable — '
          : `Gap: ${records} ${records === 1 ? 'record' : 'records'} unavailable — `,
      ),
      reason,
    ]);
    return {
      seq: record.seq,
      attemptId: record.attempt_id,
      step: null,
      gap: true,
      time: uiText(''),
      lines: [{ label: uiText(''), body: text, tone: 'warn' }],
      text,
      bytes: Buffer.byteLength(text) + ENTRY_OVERHEAD_BYTES,
    };
  }
  const lines: LogLine[] = describeRecord(record.kind, record.data).map((d) => ({
    label: sanitize(d.label),
    body: capped(d.body),
    tone: d.tone,
  }));
  if (lines.length === 0) return null;
  const time = shortTime(record.at);
  const text = joinSafe([
    time,
    ...lines.flatMap((l) => [uiText(' '), l.label, uiText(' '), l.body]),
  ]);
  return {
    seq: record.seq,
    attemptId: record.attempt_id,
    step: record.step,
    gap: false,
    time,
    lines,
    text,
    bytes: Buffer.byteLength(text) + ENTRY_OVERHEAD_BYTES,
  };
}

const sumBytes = (entries: readonly LogEntry[]): number => entries.reduce((n, e) => n + e.bytes, 0);

/** How many entries from the start of `entries` must go for the rest to fit. */
function excessFromStart(entries: readonly LogEntry[], bytes: number): number {
  let drop = Math.max(0, entries.length - LOG_BUFFER_RECORDS);
  let left = bytes;
  for (let i = 0; i < drop; i++) left -= (entries[i] as LogEntry).bytes;
  while (left > LOG_BUFFER_BYTES && drop < entries.length - 1) {
    left -= (entries[drop] as LogEntry).bytes;
    drop += 1;
  }
  return drop;
}

/** New records at the end; the oldest leave, and are read again by position if asked for. */
function appendEntries(s: LogState, entries: readonly LogEntry[]): LogState {
  // Replace a non-advancing diagnostic gap when it repeats or real records arrive after repair.
  const all = [...s.buffer.filter((e) => !(e.gap && e.seq > s.nextCursor)), ...entries];
  const bytes = sumBytes(all);
  const drop = excessFromStart(all, bytes);
  if (drop === 0) return { ...s, buffer: all, bufferBytes: bytes };
  const kept = all.slice(drop);
  return {
    ...s,
    buffer: kept,
    bufferBytes: sumBytes(kept),
    windowStart: (all[drop - 1] as LogEntry).seq,
  };
}

/** Would adding these overflow the buffer? An attempt being read then waits for the reader to get there. */
const wouldOverflow = (s: LogState, entries: readonly LogEntry[]): boolean =>
  s.buffer.length + entries.length > LOG_BUFFER_RECORDS ||
  s.bufferBytes + sumBytes(entries) > LOG_BUFFER_BYTES;

/** Earlier records at the start; when that overflows, the newest leave and forward reading goes back to them. */
function prependEntries(s: LogState, entries: readonly LogEntry[]): LogState {
  const all = [...entries, ...s.buffer];
  const bytes = s.bufferBytes + sumBytes(entries);
  const reversed = all.toReversed();
  const drop = excessFromStart(reversed, bytes);
  if (drop === 0) return { ...s, buffer: all, bufferBytes: bytes };
  const kept = all.slice(0, all.length - drop);
  return {
    ...s,
    buffer: kept,
    bufferBytes: sumBytes(kept),
    nextCursor: (kept.at(-1) as LogEntry).seq,
    moreForward: true,
  };
}

export type LogRequest =
  /** What comes next, into the buffer. */
  | { readonly kind: 'forward'; readonly after: number }
  /** Is there anything new? The answer goes nowhere but `newActivity`. */
  | { readonly kind: 'probe'; readonly after: number }
  /** Part of what left the buffer. */
  | { readonly kind: 'older'; readonly after: number };

/** What to read now, if anything. Never more than one a second unless the user just asked for something. */
export function logDue(s: LogState, now: number): LogRequest | null {
  const rested = s.lastReadAt === null || now - s.lastReadAt >= LOG_POLL_INTERVAL_MS;
  // A read that failed waits its turn, whatever it was for.
  if (s.error !== null && !rested) return null;
  if (s.older !== null) return { kind: 'older', after: s.older.cursor };
  if (s.wantOlder && s.windowStart > 0)
    return {
      kind: 'older',
      after: Math.max(0, s.windowStart - LOG_PAGE_RECORDS),
    };
  if (s.filling || s.wantForward) return { kind: 'forward', after: s.nextCursor };
  if (!rested || s.complete) return null;
  if (s.mode === 'live') return { kind: 'forward', after: s.nextCursor };
  if (s.newActivity) return null;
  return { kind: 'probe', after: s.resumeCursor ?? s.nextCursor };
}

/** The attempt filter a request travels with; a probe looks at the whole log. */
export const requestAttempt = (s: LogState, request: LogRequest): string | null =>
  request.kind === 'probe' ? null : s.attemptFilter;

function applyForward(
  s: LogState,
  entries: readonly LogEntry[],
  page: TaskLogs,
  sent: number,
): LogState {
  const asked = s.filling || s.wantForward;
  // Paused while this read was on its way: it says there is more, and nothing goes in (FR-014).
  if (s.mode !== 'live' && !asked)
    return { ...s, newActivity: s.newActivity || entries.length > 0 };
  if (s.filling && wouldOverflow(s, entries)) return { ...s, filling: false, moreForward: true };
  const next = appendEntries(s, entries);
  return {
    ...next,
    nextCursor: page.next_cursor,
    complete: page.complete,
    filling: s.filling && sent > 0 && page.next_cursor > s.nextCursor,
    wantForward: false,
    moreForward: s.wantForward ? sent > 0 : s.moreForward,
  };
}

function applyOlder(
  s: LogState,
  entries: readonly LogEntry[],
  page: TaskLogs,
  request: LogRequest,
): LogState {
  const reading: Older = s.older ?? {
    after: request.after,
    upTo: s.windowStart,
    cursor: request.after,
    collected: [],
  };
  const collected = [...reading.collected, ...entries.filter((e) => e.seq <= reading.upTo)];
  const stuck = page.next_cursor <= reading.cursor;
  if (page.next_cursor < reading.upTo && !stuck)
    return {
      ...s,
      older: { ...reading, cursor: page.next_cursor, collected },
    };
  const done: LogState = {
    ...prependEntries(s, collected),
    windowStart: reading.after,
    older: null,
  };
  // Nothing of this attempt in that stretch: keep going back, or the reader sees no change at all.
  return { ...done, wantOlder: collected.length === 0 && reading.after > 0 };
}

/** One answer from the daemon. */
export function applyLogPage(
  s: LogState,
  request: LogRequest,
  page: TaskLogs,
  at: number,
): LogState {
  const read: LogState = { ...s, lastReadAt: at, error: null };
  // Bookkeeping records are left out of the buffer; whether the daemon sent anything is the page's word.
  const entries = page.records.flatMap((r) => toEntry(r) ?? []);
  const sent = page.records.length;
  switch (request.kind) {
    case 'probe':
      return {
        ...read,
        // A probe reads one record. Bookkeeping there still means the log moved on, and what follows it
        // may be the agent speaking; hiding a record is for showing, never for telling news (FR-014).
        newActivity: s.newActivity || sent > 0,
        complete: sent === 0 && page.complete,
      };
    case 'forward':
      return applyForward(read, entries, page, sent);
    case 'older':
      return applyOlder(read, entries, page, request);
  }
}

export function failLogRead(s: LogState, error: SafeText, at: number): LogState {
  return { ...s, error, lastReadAt: at };
}

/**
 * One record on screen: a separator when `(step, attempt)` changed, then its text in rows. A record's row
 * starts with `head` cells of time and label, drawn apart from the body that follows.
 */
export type LogRow = {
  readonly kind: 'record' | 'separator' | 'gap';
  readonly text: SafeText;
  readonly tone?: Tone;
  /** Cells of the mark before the text. */
  readonly head?: number;
  /** Cells after the mark that name the tool. */
  readonly strong?: number;
  /** The text after the mark in styled pieces, for a message written in Markdown. */
  readonly segs?: readonly Seg[];
};

const wrapped = new WeakMap<LogEntry, { cols: number; rows: LogRow[] }>();

/**
 * A record as a coding agent's own transcript shows it: `•` before what the agent says or the tool it calls,
 * `⎿` under it for what came back, `✻` for session notes. Wrapped rows stay under their text.
 */
function shape(line: LogLine): {
  prefix: string;
  strong: string;
  body: string;
} {
  switch (line.tone) {
    case 'say':
      return { prefix: '• ', strong: '', body: line.body };
    case 'tool':
      return { prefix: '• ', strong: line.label, body: `(${line.body})` };
    case 'result':
    case 'error':
      return { prefix: '  ⎿  ', strong: '', body: line.body };
    case 'warn':
      return { prefix: '⚠ ', strong: '', body: line.body };
    case 'ok':
    case 'info': {
      const own = ['', 'Start', 'Think', 'Summary'].includes(line.label);
      return {
        prefix: '✻ ',
        strong: '',
        body: own
          ? line.body
          : line.tone === 'ok'
            ? `${line.label} · ${line.body}`
            : `${line.label}: ${line.body}`,
      };
    }
  }
}

function textRows(entry: LogEntry, cols: number): LogRow[] {
  const known = wrapped.get(entry);
  if (known?.cols === cols) return known.rows;
  const kind = entry.gap ? 'gap' : 'record';
  const rows: LogRow[] = [];
  if (entry.gap || cols < 24)
    for (const text of wrap(entry.text, cols))
      rows.push({ kind, text, tone: entry.lines[0]?.tone ?? 'info' });
  else
    for (const line of entry.lines) {
      const { prefix, strong, body } = shape(line);
      // A new thing the agent says or does starts after a blank row, as in its own transcript.
      if (line.tone === 'say' || line.tone === 'tool')
        rows.push({ kind, text: uiText(''), tone: line.tone });
      const head = displayWidth(prefix);
      if (line.tone === 'say') {
        markdownRows(line.body, cols - head).forEach((segs, r) =>
          rows.push({
            kind,
            text: uiText(
              `${r === 0 ? prefix : ' '.repeat(head)}${segs.map((g) => g.text).join('')}`,
            ),
            tone: line.tone,
            head,
            segs,
          }),
        );
        continue;
      }
      const first = `${strong}${body}`;
      wrap(uiText(first), cols - head).forEach((text, r) =>
        rows.push({
          kind,
          text: uiText(`${r === 0 ? prefix : ' '.repeat(head)}${text}`),
          tone: line.tone,
          head,
          strong: r === 0 ? displayWidth(strong) : 0,
        }),
      );
    }
  wrapped.set(entry, { cols, rows });
  return rows;
}

function separator(entry: LogEntry, prev: LogEntry | undefined): SafeText | null {
  if (entry.gap) return null;
  const same =
    prev === undefined
      ? entry.step === null && entry.attemptId === null
      : !prev.gap && prev.step === entry.step && prev.attemptId === entry.attemptId;
  if (same) return null;
  // A gap has no step to compare with; only a change of attempt after one is news.
  const words = entry.step === null ? null : stepWords(entry.step);
  return joinSafe([
    uiText('── '),
    entry.step ?? uiText('outside any step'),
    uiText(words === null ? '' : ` · ${words}`),
    uiText(entry.attemptId === null ? ' ──' : ` · attempt ${shortAttempt(entry.attemptId)} ──`),
  ]);
}

function entryRows(entry: LogEntry, prev: LogEntry | undefined, cols: number): LogRow[] {
  const sep = separator(entry, prev);
  const rows = textRows(entry, cols);
  return sep === null ? rows : [{ kind: 'separator', text: sep }, ...rows];
}

function indexOfSeq(buffer: readonly LogEntry[], seq: number): number {
  let lo = 0;
  let hi = buffer.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((buffer[mid] as LogEntry).seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Rows from `from` on, until there are `count`. Only those records get wrapped, however long the buffer. */
function rowsFrom(
  s: LogState,
  from: { readonly index: number; readonly row: number },
  cols: number,
  count: number,
): { row: LogRow; index: number; inner: number }[] {
  const out: { row: LogRow; index: number; inner: number }[] = [];
  for (let i = from.index; i < s.buffer.length && out.length < count; i++) {
    const rows = entryRows(s.buffer[i] as LogEntry, s.buffer[i - 1], cols);
    // The place was kept on another width, where this record may have had more rows.
    const first = i === from.index ? Math.min(from.row, rows.length - 1) : 0;
    for (let r = first; r < rows.length; r++) {
      if (out.length === count) break;
      out.push({ row: rows[r] as LogRow, index: i, inner: r });
    }
  }
  return out;
}

/** Where a window of `height` rows ending at the buffer's end starts. */
function lastScreen(s: LogState, cols: number, height: number): { index: number; row: number } {
  let needed = height;
  for (let i = s.buffer.length - 1; i >= 0; i--) {
    const count = entryRows(s.buffer[i] as LogEntry, s.buffer[i - 1], cols).length;
    if (count >= needed) return { index: i, row: count - needed };
    needed -= count;
  }
  return { index: 0, row: 0 };
}

function topOf(s: LogState): { index: number; row: number } {
  return s.anchor === null
    ? { index: 0, row: 0 }
    : { index: indexOfSeq(s.buffer, s.anchor.seq), row: s.anchor.row };
}

/** What fills the log area now. */
export function visibleRows(s: LogState, cols: number, height: number): readonly LogRow[] {
  if (height <= 0 || s.buffer.length === 0) return [];
  const from = s.mode === 'live' ? lastScreen(s, cols, height) : topOf(s);
  return rowsFrom(s, from, cols, height).map((r) => r.row);
}

const anchored = (
  s: LogState,
  at: { readonly index: number; readonly row: number },
): LogState['anchor'] => ({
  seq: (s.buffer[at.index] as LogEntry).seq,
  row: at.row,
});

/** Scrolls by rows; going up pauses, because the place being read must then hold (data-model.md). */
export function scrollLogs(given: LogState, cols: number, height: number, delta: number): LogState {
  if (given.buffer.length === 0)
    return delta < 0 && given.windowStart > 0 ? { ...given, wantOlder: true } : given;
  if (given.mode === 'live' && delta >= 0) return given;
  const s: LogState =
    given.mode === 'live'
      ? {
          ...given,
          mode: 'paused',
          anchor: anchored(given, lastScreen(given, cols, height)),
        }
      : given;
  if (delta >= 0) {
    const rows = rowsFrom(s, topOf(s), cols, delta + height);
    const room = Math.max(0, rows.length - height);
    const go = Math.min(delta, room);
    const target = rows[go];
    const atEnd = delta > room && s.moreForward;
    return {
      ...s,
      wantForward: s.wantForward || atEnd,
      anchor:
        target === undefined ? s.anchor : anchored(s, { index: target.index, row: target.inner }),
    };
  }
  let { index, row } = topOf(s);
  row = Math.min(row, entryRows(s.buffer[index] as LogEntry, s.buffer[index - 1], cols).length - 1);
  let left = -delta;
  while (left > 0) {
    if (row >= left) {
      row -= left;
      left = 0;
    } else {
      left -= row;
      if (index === 0) {
        row = 0;
        break;
      }
      index -= 1;
      left -= 1;
      row = entryRows(s.buffer[index] as LogEntry, s.buffer[index - 1], cols).length - 1;
      if (left === 0) break;
    }
  }
  return {
    ...s,
    anchor: anchored(s, { index, row }),
    wantOlder: s.wantOlder || (left > 0 && s.windowStart > 0),
  };
}

/** The top of what the buffer holds; from there what left it is one `↑` away. */
export const logsTop = (s: LogState): LogState => ({
  ...s,
  mode: 'paused',
  anchor: null,
});

/** The end of what the buffer holds; following the log is another key, `F`. */
export function logsEnd(s: LogState, cols: number, height: number): LogState {
  if (s.mode === 'live' || s.buffer.length === 0) return s;
  return {
    ...s,
    anchor: anchored(s, lastScreen(s, cols, height)),
    wantForward: s.wantForward || s.moreForward,
  };
}

export function pauseLogs(s: LogState, cols: number, height: number): LogState {
  if (s.mode === 'paused') return s;
  return {
    ...s,
    mode: 'paused',
    anchor: s.buffer.length === 0 ? null : anchored(s, lastScreen(s, cols, height)),
  };
}

/** Back to following the whole log, from where it was left. */
export function followLogs(s: LogState): LogState {
  const base: LogState = {
    ...s,
    // A read on its way asked for something else: an old page or "anything new?" is no answer now.
    generation: s.generation + 1,
    mode: 'live',
    newActivity: false,
    anchor: null,
    wantForward: false,
    wantOlder: false,
    older: null,
    filling: false,
    moreForward: false,
    complete: false,
    picker: null,
  };
  if (s.resumeCursor === null) return base;
  return {
    ...base,
    attemptFilter: null,
    buffer: [],
    bufferBytes: 0,
    windowStart: s.resumeCursor,
    nextCursor: s.resumeCursor,
    resumeCursor: null,
    // Nothing new may ever come on a quiet log, so the screen must not wait for it to show anything.
    wantOlder: s.resumeCursor > 0,
  };
}

/** Reads one attempt from its start; the rest of the log is only watched for news. */
export function filterAttempt(s: LogState, attemptId: string): LogState {
  return {
    ...s,
    generation: s.generation + 1,
    mode: 'paused',
    attemptFilter: attemptId,
    buffer: [],
    bufferBytes: 0,
    windowStart: 0,
    nextCursor: 0,
    resumeCursor: s.resumeCursor ?? s.nextCursor,
    anchor: null,
    filling: true,
    moreForward: false,
    wantForward: false,
    wantOlder: false,
    older: null,
    complete: false,
    newActivity: false,
    picker: null,
  };
}

/** After a change of token nothing read under the old one may stay on screen. */
export function forgetLogs(s: LogState, session: number): LogState {
  // The title was read under the old token too; the ID is what the user chose.
  return initialLogs(s.taskId, sanitize(s.taskId), session);
}
