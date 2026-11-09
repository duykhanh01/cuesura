/**
 * The Logs screen's state (feature 004 data model, "Log state", FR-014, FR-039, EC-011). It holds one step at a
 * time, the latest or the attempt asked for, never more than the cap: what leaves it is read again by
 * position, because the daemon's cursor does not change through rotation or restart. The place being read is kept by record, not by row, so
 * neither a resize nor new records can move it.
 */
import { LOG_POLL_INTERVAL_MS } from '../client/refresh.ts';
import type { TaskLogs } from '../client/schemas.ts';
import { joinSafe, sanitize, sanitizeLines, uiText, type SafeText } from '../terminal/safe-text.ts';
import { displayWidth, truncate, wrap } from '../terminal/width.ts';
import { stepWords } from './activity.ts';
import type { GatesView } from './gates.ts';
import { describeRecord, type Tone } from './log-text.ts';
import type { Seg } from '../views/ink.ts';
import { markdownRows } from '../views/markdown.ts';

export const LOG_BUFFER_RECORDS = 5_000;
export const LOG_BUFFER_BYTES = 8 * 1024 * 1024;
/** The daemon's page; also how far back one reading of older records reaches. */
export const LOG_PAGE_RECORDS = 200;
/** The progress column beside the log, when the terminal is wide enough for both. */
const PROGRESS_PANE = 30;
const TWO_COLUMNS_FROM = 100;
/** With room to spare the column widens, so a reason wraps less; narrower, the log needs those columns more. */
const PROGRESS_PANE_WIDE = 36;
const WIDE_FROM = 120;

/** Columns of the log: what is left of the terminal beside the progress column and its rule. */
export function logColumns(
  cols: number,
  paneHidden = false,
): {
  readonly pane: number;
  readonly log: number;
} {
  if (paneHidden || cols < TWO_COLUMNS_FROM) return { pane: 0, log: cols };
  const pane = cols >= WIDE_FROM ? PROGRESS_PANE_WIDE : PROGRESS_PANE;
  return { pane, log: cols - pane - 2 };
}

/** Title, what is being followed, and one row for news. */
export const LOG_HEADER_ROWS = 3;

/** Rows of log in a body `height` rows high: the last one stays empty, to set the log off from the key bar. */
export const logRows = (height: number): number => Math.max(1, height - LOG_HEADER_ROWS - 1);
/** A record can be 256 KiB on one line; drawing that on every frame would hold the keys up (EC-011). */
const LOG_TEXT_CHARS = 16 * 1024;
const ENTRY_OVERHEAD_BYTES = 128;

/** One line a record reads as: a short label, what it says, and its tone. */
export type LogLine = {
  readonly label: SafeText;
  readonly body: SafeText;
  readonly tone: Tone;
  /** Shown instead of `body` in the full-output view. */
  readonly full?: SafeText;
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
  /** Paused by scrolling up rather than on asking: coming back to the end follows again, as a chat does. */
  readonly scrolledAway: boolean;
  readonly attemptFilter: string | null;
  /** The attempt the log had reached when reading one began; the attempt list can lag behind it. */
  readonly latestSeen: string | null;
  readonly buffer: readonly LogEntry[];
  readonly bufferBytes: number;
  /** The cursor just before the buffer's first record; above 0 means more of this step can be read again. */
  readonly windowStart: number;
  /** Where the next forward read starts. */
  readonly nextCursor: number;
  /** While an attempt is being read: where following the latest step goes on from. */
  readonly resumeCursor: number | null;
  readonly newActivity: boolean;
  /** The first row on screen while paused; `null` is the top of the buffer, `end` its last screen. */
  readonly anchor: { readonly seq: number; readonly row: number } | 'end' | null;
  /** Nothing read yet: the first read is the last page, so the screen opens at the end, as a chat does. */
  readonly tailing: boolean;
  /** The daemon has more after `nextCursor` than one page held; following reads on without waiting. */
  readonly behind: boolean;
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
  /** When the newest record read was written, bookkeeping too: a heartbeat says it is alive. */
  readonly lastOutputAt: number | null;
  /** Tool calls and their output in full; else one row each, as a coding agent's own transcript does. */
  readonly expanded: boolean;
  /** The log has the whole width: a terminal selects across columns, so this is how to copy it alone. */
  readonly paneHidden: boolean;
  /** The attempt chooser is open, its cursor on the row of this key (`attempt-tree.ts`). */
  readonly picker: string | null;
  /** Keys of the chooser's rounds and runs shown unfolded. */
  readonly pickerOpen: readonly string[];
  /** The gates are being read in place of the agent log, which goes on underneath. */
  readonly gates: GatesView | null;
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
    scrolledAway: false,
    attemptFilter: null,
    latestSeen: null,
    buffer: [],
    bufferBytes: 0,
    windowStart: 0,
    nextCursor: 0,
    resumeCursor: null,
    newActivity: false,
    anchor: null,
    tailing: true,
    behind: false,
    filling: false,
    moreForward: false,
    wantForward: false,
    wantOlder: false,
    older: null,
    complete: false,
    error: null,
    lastReadAt: null,
    lastOutputAt: null,
    expanded: false,
    paneHidden: false,
    picker: null,
    pickerOpen: [],
    gates: null,
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
    ...(d.full === undefined ? {} : { full: capped(d.full) }),
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
    bytes:
      Buffer.byteLength(text) +
      lines.reduce((n, l) => n + Buffer.byteLength(l.full ?? ''), 0) +
      ENTRY_OVERHEAD_BYTES,
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

/** A record that opens a step. A gap does not: a late one can name an earlier worker. */
const ofAttempt = (e: LogEntry): boolean => !e.gap && e.attemptId !== null;

/** Records outside any attempt have no step to go back to, so they stay with the step that follows them. */
const sameStep = (e: LogEntry, step: LogEntry): boolean =>
  e.attemptId === null || (e.attemptId === step.attemptId && (e.gap || e.step === step.step));

/** The attempt of the step the log has reached. */
export const latestAttempt = (s: LogState): string | null =>
  s.buffer.findLast(ofAttempt)?.attemptId ?? null;

/**
 * Only the step the log has reached stays, so each step reads on its own. Its start is then known, and nothing
 * before it is to be read again: `windowStart` goes to 0.
 */
function keepLatestStep(s: LogState): LogState {
  if (s.attemptFilter !== null) return s;
  const last = s.buffer.findLastIndex(ofAttempt);
  if (last <= 0) return s;
  let first = last;
  while (first > 0 && sameStep(s.buffer[first - 1] as LogEntry, s.buffer[last] as LogEntry))
    first -= 1;
  if (first === 0) return s;
  const kept = s.buffer.slice(first);
  return { ...s, buffer: kept, bufferBytes: sumBytes(kept), windowStart: 0 };
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
  /** The last page, in place of whatever the buffer held. */
  | { readonly kind: 'tail'; readonly after: number }
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
  if (s.tailing) return { kind: 'tail', after: 0 };
  if (s.older !== null) return { kind: 'older', after: s.older.cursor };
  if (s.wantOlder && s.windowStart > 0)
    return {
      kind: 'older',
      after: Math.max(0, s.windowStart - LOG_PAGE_RECORDS),
    };
  // A full page while following means the log ran ahead: catch up now rather than a page a second.
  if (s.filling || s.wantForward || (s.mode === 'live' && s.behind))
    return { kind: 'forward', after: s.nextCursor };
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
  const read: LogState = {
    ...next,
    nextCursor: page.next_cursor,
    complete: page.complete,
    filling: s.filling && sent > 0 && page.next_cursor > s.nextCursor,
    behind: (page.more ?? false) && page.next_cursor > s.nextCursor,
    wantForward: false,
    moreForward: s.wantForward ? sent > 0 : s.moreForward,
  };
  // Paused, the place being read stays even when the next step comes into the buffer.
  return s.mode === 'live' ? keepLatestStep(read) : read;
}

/** The last page: the buffer starts again from it, and what precedes it is one `↑` away. */
function applyTail(s: LogState, entries: readonly LogEntry[], page: TaskLogs): LogState {
  const start = page.after ?? 0;
  const more = page.more ?? false;
  return keepLatestStep({
    ...appendEntries({ ...s, buffer: [], bufferBytes: 0, windowStart: start }, entries),
    nextCursor: page.next_cursor,
    complete: page.complete,
    tailing: false,
    behind: more,
    // One attempt is read to its end whether or not it is followed; the latest step catches up while live.
    filling: s.attemptFilter !== null && more,
  });
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
  return keepLatestStep({ ...done, wantOlder: collected.length === 0 && reading.after > 0 });
}

function newestOutput(known: number | null, page: TaskLogs): number | null {
  const last = page.records.findLast((r) => !('gap' in r));
  const at = last === undefined || 'gap' in last ? Number.NaN : Date.parse(last.at);
  return Number.isNaN(at) ? known : Math.max(known ?? at, at);
}

/** One answer from the daemon. */
export function applyLogPage(
  s: LogState,
  request: LogRequest,
  page: TaskLogs,
  at: number,
): LogState {
  const read: LogState = {
    ...s,
    lastReadAt: at,
    error: null,
    lastOutputAt: newestOutput(s.lastOutputAt, page),
  };
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
    case 'tail':
      return applyTail(read, entries, page);
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

const wrapped = new WeakMap<LogEntry, { cols: number; expanded: boolean; rows: LogRow[] }>();

/** Plain output and what needs reading stay whole: only calls, their results and session notes fold. */
const folds = (line: LogLine): boolean =>
  line.tone === 'tool' ||
  line.tone === 'result' ||
  line.tone === 'ok' ||
  (line.tone === 'info' && line.label !== '');

/** The rows of a failed output shown while folded: it needs reading, but must not push the rest away. */
const ERROR_LINES = 4;

const moreLines = (n: number): string => `+${n} ${n === 1 ? 'line' : 'lines'}`;

function errorText(body: string): string {
  const lines = body.split('\n');
  if (lines.length <= ERROR_LINES + 1) return body;
  return [...lines.slice(0, ERROR_LINES), `… ${moreLines(lines.length - ERROR_LINES)}`].join('\n');
}

/** The first line of `body` in `room` cells, and how many lines that leaves out. */
function foldedText(body: string, room: number): SafeText {
  const lines = body.split('\n');
  const more = lines.length - 1;
  const tail = more > 0 ? `  ${moreLines(more)}` : '';
  return joinSafe([truncate(uiText(lines[0] ?? ''), room - displayWidth(tail)), uiText(tail)]);
}

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
      return { prefix: '  ⎿  ', strong: '', body: line.body };
    case 'error':
      return { prefix: '✗ ⎿  ', strong: '', body: line.body };
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

function textRows(entry: LogEntry, cols: number, expanded: boolean): LogRow[] {
  const known = wrapped.get(entry);
  if (known?.cols === cols && known.expanded === expanded) return known.rows;
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
      const first = `${strong}${expanded ? (line.full ?? body) : body}`;
      if (!expanded && folds(line)) {
        rows.push({
          kind,
          text: uiText(`${prefix}${foldedText(first, cols - head)}`),
          tone: line.tone,
          head,
          strong: displayWidth(strong),
        });
        continue;
      }
      const whole = !expanded && line.tone === 'error' ? errorText(first) : first;
      wrap(uiText(whole), cols - head).forEach((text, r) =>
        rows.push({
          kind,
          text: uiText(`${r === 0 ? prefix : ' '.repeat(head)}${text}`),
          tone: line.tone,
          head,
          strong: r === 0 ? displayWidth(strong) : 0,
        }),
      );
    }
  wrapped.set(entry, { cols, expanded, rows });
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

function entryRows(
  entry: LogEntry,
  prev: LogEntry | undefined,
  cols: number,
  expanded: boolean,
): LogRow[] {
  const sep = separator(entry, prev);
  const rows = textRows(entry, cols, expanded);
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
    const rows = entryRows(s.buffer[i] as LogEntry, s.buffer[i - 1], cols, s.expanded);
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
    const count = entryRows(s.buffer[i] as LogEntry, s.buffer[i - 1], cols, s.expanded).length;
    if (count >= needed) return { index: i, row: count - needed };
    needed -= count;
  }
  return { index: 0, row: 0 };
}

function topOf(s: LogState, cols: number, height: number): { index: number; row: number } {
  if (s.mode === 'live' || s.anchor === 'end') return lastScreen(s, cols, height);
  return s.anchor === null
    ? { index: 0, row: 0 }
    : { index: indexOfSeq(s.buffer, s.anchor.seq), row: s.anchor.row };
}

/** What fills the log area now. */
export function visibleRows(s: LogState, cols: number, height: number): readonly LogRow[] {
  if (height <= 0 || s.buffer.length === 0) return [];
  const from = topOf(s, cols, height);
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
    given.mode === 'live' || given.anchor === 'end'
      ? {
          ...given,
          mode: 'paused',
          scrolledAway: given.mode === 'live' || given.scrolledAway,
          anchor: anchored(given, lastScreen(given, cols, height)),
        }
      : given;
  if (delta >= 0) {
    // One row past the move, to tell the last screen from a screen that only reads as far as was asked.
    const rows = rowsFrom(s, topOf(s, cols, height), cols, delta + height + 1);
    const room = Math.max(0, rows.length - height);
    const go = Math.min(delta, room);
    const target = rows[go];
    const atEnd = delta > room && s.moreForward;
    if (rows.length <= go + height && backToEnd(s)) return followLogs(s);
    return {
      ...s,
      wantForward: s.wantForward || atEnd,
      anchor:
        target === undefined ? s.anchor : anchored(s, { index: target.index, row: target.inner }),
    };
  }
  let { index, row } = topOf(s, cols, height);
  row = Math.min(
    row,
    entryRows(s.buffer[index] as LogEntry, s.buffer[index - 1], cols, s.expanded).length - 1,
  );
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
      row =
        entryRows(s.buffer[index] as LogEntry, s.buffer[index - 1], cols, s.expanded).length - 1;
      if (left === 0) break;
    }
  }
  return {
    ...s,
    anchor: anchored(s, { index, row }),
    wantOlder: s.wantOlder || (left > 0 && s.windowStart > 0),
  };
}

/** Back at the end of everything read, having only scrolled away: nothing says to stay there. */
const backToEnd = (s: LogState): boolean =>
  s.scrolledAway && !s.moreForward && s.attemptFilter === null;

/** The top of what the buffer holds; from there what left it is one `↑` away. */
export const logsTop = (s: LogState): LogState => ({
  ...s,
  mode: 'paused',
  scrolledAway: s.mode === 'live' || s.scrolledAway,
  anchor: null,
});

/** The end of what the buffer holds. A pause asked for stays: following is then `Space`. */
export function logsEnd(s: LogState, cols: number, height: number): LogState {
  if (s.mode === 'live' || s.buffer.length === 0) return s;
  if (backToEnd(s)) return followLogs(s);
  return {
    ...s,
    anchor: anchored(s, lastScreen(s, cols, height)),
    wantForward: s.wantForward || s.moreForward,
  };
}

/** Rows change under the place being read; the record at the top of the screen stays there. */
const recordTop = (s: LogState): LogState['anchor'] =>
  s.anchor === null || s.anchor === 'end' ? s.anchor : { ...s.anchor, row: 0 };

export const toggleOutput = (s: LogState): LogState => ({
  ...s,
  expanded: !s.expanded,
  anchor: recordTop(s),
});

export const togglePane = (s: LogState): LogState => ({
  ...s,
  paneHidden: !s.paneHidden,
  anchor: recordTop(s),
});

export function pauseLogs(s: LogState, cols: number, height: number): LogState {
  if (s.mode === 'paused') return s;
  return {
    ...s,
    mode: 'paused',
    anchor: s.buffer.length === 0 ? null : anchored(s, lastScreen(s, cols, height)),
  };
}

/** Back to following the latest step, from where it was left. */
export function followLogs(s: LogState): LogState {
  const base: LogState = {
    ...s,
    // A read on its way asked for something else: an old page or "anything new?" is no answer now.
    generation: s.generation + 1,
    mode: 'live',
    scrolledAway: false,
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
  // Back from one attempt: the log is read from its last page again, as on opening.
  return {
    ...base,
    attemptFilter: null,
    buffer: [],
    bufferBytes: 0,
    windowStart: 0,
    nextCursor: 0,
    resumeCursor: null,
    tailing: true,
    behind: false,
  };
}

/** Reads one attempt from its last page, shown at its end; the rest of the log is only watched for news. */
export function filterAttempt(s: LogState, attemptId: string): LogState {
  return {
    ...s,
    generation: s.generation + 1,
    mode: 'paused',
    scrolledAway: false,
    attemptFilter: attemptId,
    latestSeen: s.attemptFilter === null ? latestAttempt(s) : s.latestSeen,
    buffer: [],
    bufferBytes: 0,
    windowStart: 0,
    nextCursor: 0,
    resumeCursor: s.resumeCursor ?? s.nextCursor,
    anchor: 'end',
    tailing: true,
    behind: false,
    filling: false,
    moreForward: false,
    wantForward: false,
    wantOlder: false,
    older: null,
    complete: false,
    newActivity: false,
    picker: null,
  };
}
