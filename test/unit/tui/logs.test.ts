import { describe, expect, it } from 'vitest';
import type { TaskLogs } from '../../../src/tui/client/schemas.ts';
import {
  applyLogPage,
  failLogRead,
  filterAttempt,
  followLogs,
  initialLogs,
  LOG_BUFFER_BYTES,
  LOG_BUFFER_RECORDS,
  LOG_PAGE_RECORDS,
  logDue,
  latestAttempt,
  logsEnd,
  logsTop,
  pauseLogs,
  requestAttempt,
  scrollLogs,
  toEntry,
  visibleRows,
  type LogState,
  logColumns,
  toggleOutput,
  togglePane,
} from '../../../src/tui/model/logs.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';

// T047: the rules of the log's state, without a terminal. These only guard against regressions; US2 is judged
// by the PTY tests.
const TASK = '00000000-0000-7000-8000-000000000001';
const ATTEMPT = '00000000-0000-7000-8000-000000000a01';
const COLS = 60;
const HEIGHT = 5;

type Rec = TaskLogs['records'][number];

function record(
  seq: number,
  text = `line ${seq}`,
  attempt: string | null = ATTEMPT,
  step: string | null = 'code',
): Rec {
  return {
    seq,
    cursor: seq,
    operation_id: 'op',
    attempt_id: attempt,
    step: step === null ? null : sanitize(step),
    at: sanitize('2026-11-01T10:20:30.000Z'),
    kind: sanitize('progress'),
    data: text,
  };
}

function page(records: readonly Rec[], next: number, complete = false): TaskLogs {
  return {
    task_id: TASK,
    records: [...records],
    next_cursor: next,
    complete,
  } as TaskLogs;
}

/** A log whose last page has been read and that is followed from cursor 0 on. */
const start = (): LogState => ({ ...initialLogs(TASK, uiText('Task'), 1), tailing: false });
const forward = (after: number) => ({ kind: 'forward', after }) as const;
const probe = (after: number) => ({ kind: 'probe', after }) as const;

/** Reads `count` records from `from` on, in pages as the daemon gives them. */
function fed(s: LogState, from: number, count: number, text?: (n: number) => string): LogState {
  let next = s;
  for (let at = from; at < from + count; at += LOG_PAGE_RECORDS) {
    const end = Math.min(at + LOG_PAGE_RECORDS, from + count);
    const records = Array.from({ length: end - at }, (_, i) => record(at + i, text?.(at + i)));
    next = applyLogPage(next, forward(next.nextCursor), page(records, end - 1), 0);
  }
  return next;
}

const screenTexts = (s: LogState): string[] => visibleRows(s, COLS, HEIGHT).map((r) => r.text);

describe('the buffer (FR-039)', () => {
  it('never holds more than 5,000 records, and knows where the window starts', () => {
    const s = fed(start(), 1, LOG_BUFFER_RECORDS + 450);
    expect(s.buffer).toHaveLength(LOG_BUFFER_RECORDS);
    expect(s.buffer[0]?.seq).toBe(451);
    expect(s.windowStart).toBe(450);
    expect(s.nextCursor).toBe(LOG_BUFFER_RECORDS + 450);
  });

  it('never holds more than 8 MiB, whatever the number of records', () => {
    const big = 'x'.repeat(15 * 1024);
    const s = fed(start(), 1, 1_000, () => big);
    expect(s.bufferBytes).toBeLessThanOrEqual(LOG_BUFFER_BYTES);
    expect(s.buffer.length).toBeLessThan(1_000);
    expect(s.windowStart).toBe((s.buffer[0]?.seq ?? 0) - 1);
    expect(s.bufferBytes).toBe(s.buffer.reduce((n, e) => n + e.bytes, 0));
  });

  it('cuts one enormous record for showing, and says how much', () => {
    const entry = toEntry(record(1, 'y'.repeat(256 * 1024)))!;
    expect(entry.text.length).toBeLessThan(17 * 1024);
    expect(entry.text).toMatch(/more characters: see cusr task logs/);
  });
});

describe('live, paused and an attempt (data-model.md)', () => {
  it('live reads what comes next at most once a second', () => {
    const s = applyLogPage(start(), forward(0), page([record(1)], 1), 1_000);
    expect(logDue(s, 1_500)).toBeNull();
    expect(logDue(s, 2_000)).toEqual(forward(1));
  });

  it('paused only notes that there is something new, and nothing enters the buffer', () => {
    const live = fed(start(), 1, 10);
    const paused = pauseLogs(live, COLS, HEIGHT);
    expect(logDue(paused, 5_000)).toEqual(probe(10));
    const told = applyLogPage(paused, probe(10), page([record(11)], 11), 5_000);
    expect(told.newActivity).toBe(true);
    expect(told.buffer).toHaveLength(10);
    expect(told.nextCursor).toBe(10);
    // Known already: it stops asking until the reader comes back.
    expect(logDue(told, 9_000)).toBeNull();
  });

  it('a read on its way when the user paused adds nothing either', () => {
    const live = fed(start(), 1, 10);
    const paused = pauseLogs(live, COLS, HEIGHT);
    const after = applyLogPage(paused, forward(10), page([record(11)], 11), 1);
    expect(after.buffer).toHaveLength(10);
    expect(after.nextCursor).toBe(10);
    expect(after.newActivity).toBe(true);
  });

  it('following again turns away the answer to a question asked while paused', () => {
    const paused = pauseLogs(fed(start(), 1, 10), COLS, HEIGHT);
    expect(followLogs(paused).generation).toBeGreaterThan(paused.generation);
  });

  it('nothing new is no activity', () => {
    const paused = pauseLogs(fed(start(), 1, 3), COLS, HEIGHT);
    expect(applyLogPage(paused, probe(3), page([], 3), 1).newActivity).toBe(false);
  });

  it('following again goes on from the same cursor, so nothing is lost or repeated', () => {
    const paused = pauseLogs(fed(start(), 1, 10), COLS, HEIGHT);
    const told = applyLogPage(paused, probe(10), page([record(11)], 11), 1);
    const live = followLogs(told);
    expect(live.mode).toBe('live');
    expect(live.newActivity).toBe(false);
    expect(logDue(live, 10_000)).toEqual(forward(10));
    const more = applyLogPage(live, forward(10), page([record(11)], 11), 10_000);
    expect(more.buffer.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('an attempt opens at its last page, then is only watched; the whole log is kept for coming back', () => {
    const live = fed(start(), 1, 50);
    const s = filterAttempt(live, ATTEMPT);
    expect(s.mode).toBe('paused');
    expect(s.buffer).toEqual([]);
    const tail = { kind: 'tail', after: 0 } as const;
    expect(logDue(s, 0)).toEqual(tail);
    expect(requestAttempt(s, tail)).toBe(ATTEMPT);
    const read = applyLogPage(s, tail, { ...page([record(3), record(4)], 10), after: 2 }, 0);
    expect(read.buffer).toHaveLength(2);
    expect(read.windowStart).toBe(2);
    expect(read.filling).toBe(false);
    // Paused on the attempt, yet shown at its end.
    expect(visibleRows(read, COLS, 1).at(-1)?.text).toContain('line 4');

    // Watching looks at the whole log from where following stopped.
    const watch = logDue(read, 5_000);
    expect(watch).toEqual(probe(50));
    expect(requestAttempt(read, probe(50))).toBeNull();
    const told = applyLogPage(read, probe(50), page([record(51)], 51), 5_000);
    expect(told.newActivity).toBe(true);
    expect(told.buffer).toHaveLength(2);

    const back = followLogs(told);
    expect(back.attemptFilter).toBeNull();
    // Back on the whole log, it opens at its last page again.
    expect(logDue(back, 9_000)).toEqual(tail);
    expect(back.generation).toBeGreaterThan(told.generation);
  });

  it('an attempt longer than the buffer stops at the cap and goes on when the reader gets to the end', () => {
    let s = filterAttempt(start(), ATTEMPT);
    const first = Array.from({ length: LOG_PAGE_RECORDS }, (_, i) => record(i + 1));
    s = applyLogPage(
      s,
      { kind: 'tail', after: 0 },
      { ...page(first, LOG_PAGE_RECORDS), after: 0, more: true },
      0,
    );
    // The daemon's last page was cut short by its bytes: the rest of the attempt is read on.
    expect(s.filling).toBe(true);
    for (let at = LOG_PAGE_RECORDS + 1; at <= LOG_BUFFER_RECORDS; at += LOG_PAGE_RECORDS) {
      const records = Array.from({ length: LOG_PAGE_RECORDS }, (_, i) => record(at + i));
      s = applyLogPage(s, forward(s.nextCursor), page(records, at + LOG_PAGE_RECORDS - 1), 0);
    }
    expect(s.buffer).toHaveLength(LOG_BUFFER_RECORDS);
    s = applyLogPage(
      s,
      forward(s.nextCursor),
      page([record(LOG_BUFFER_RECORDS + 1)], LOG_BUFFER_RECORDS + 1),
      0,
    );
    expect(s.filling).toBe(false);
    expect(s.moreForward).toBe(true);
    expect(s.buffer).toHaveLength(LOG_BUFFER_RECORDS);

    const atEnd = logsEnd(scrollLogs(s, COLS, HEIGHT, -1), COLS, HEIGHT);
    expect(atEnd.wantForward).toBe(true);
    expect(logDue(atEnd, 0)).toEqual(forward(LOG_BUFFER_RECORDS));
  });

  it('opens at the end of the log, as a chat does, and reads earlier records only on the way up', () => {
    const s = initialLogs(TASK, uiText('Task'), 1);
    expect(logDue(s, 0)).toEqual({ kind: 'tail', after: 0 });
    const records = Array.from({ length: LOG_PAGE_RECORDS }, (_, i) => record(301 + i));
    const read = applyLogPage(
      s,
      { kind: 'tail', after: 0 },
      { ...page(records, 500), after: 300, more: false },
      0,
    );
    expect(read.mode).toBe('live');
    expect(read.windowStart).toBe(300);
    expect(read.nextCursor).toBe(500);
    expect(visibleRows(read, COLS, 1).at(-1)?.text).toContain('line 500');
    // Following goes on from the end, at its usual pace.
    expect(logDue(read, 500)).toBeNull();
    expect(logDue(read, 1_000)).toEqual(forward(500));
    // Up past the top asks for the page before it.
    const up = scrollLogs(read, COLS, HEIGHT, -100_000);
    expect(logDue(up, 0)).toEqual({ kind: 'older', after: 100 });
  });

  it('a log running ahead of a full page is caught up at once, not a page a second', () => {
    const records = Array.from({ length: LOG_PAGE_RECORDS }, (_, i) => record(i + 1));
    const behind = applyLogPage(
      start(),
      forward(0),
      { ...page(records, LOG_PAGE_RECORDS), more: true },
      0,
    );
    expect(logDue(behind, 0)).toEqual(forward(LOG_PAGE_RECORDS));
    const caught = applyLogPage(
      behind,
      forward(LOG_PAGE_RECORDS),
      { ...page([record(201)], 201), more: false },
      0,
    );
    expect(logDue(caught, 0)).toBeNull();
  });

  it('a finished task with nothing left stops being read', () => {
    const s = applyLogPage(start(), forward(0), page([record(1)], 1, true), 0);
    expect(s.complete).toBe(true);
    expect(logDue(s, 60_000)).toBeNull();
  });

  it('a failed read waits a second and keeps what was read', () => {
    const s = failLogRead(fed(start(), 1, 3), sanitize('gone'), 1_000);
    expect(s.buffer).toHaveLength(3);
    expect(s.error).toBe('gone');
    expect(logDue(s, 1_500)).toBeNull();
    expect(logDue(s, 2_000)).toEqual(forward(3));
  });
});

describe('one step at a time', () => {
  const NEXT = '00000000-0000-7000-8000-000000000a02';
  const coding = (): LogState =>
    applyLogPage(start(), forward(0), page([record(1), record(2)], 2), 0);
  const seqs = (s: LogState): number[] => s.buffer.map((e) => e.seq);

  it('following, the next step replaces the one before and opens with its name', () => {
    const s = applyLogPage(coding(), forward(2), page([record(3, 'c', NEXT, 'fix')], 3), 0);
    expect(seqs(s)).toEqual([3]);
    expect(s.windowStart).toBe(0);
    expect(s.bufferBytes).toBe(s.buffer[0]?.bytes);
    expect(visibleRows(s, COLS, HEIGHT)[0]?.text).toBe(`── fix · attempt 00000a02 ──`);
    expect(latestAttempt(s)).toBe(NEXT);
  });

  it('a last page that spans two steps opens on the latest, with nothing to read above it', () => {
    const s = applyLogPage(
      initialLogs(TASK, uiText('Task'), 1),
      { kind: 'tail', after: 0 },
      { ...page([record(1), record(2, 'b', NEXT, 'fix')], 2), after: 0 },
      0,
    );
    expect(seqs(s)).toEqual([2]);
    expect(scrollLogs(s, COLS, HEIGHT, -1).wantOlder).toBe(false);
  });

  it('reading back stops where the step starts', () => {
    const s = {
      ...applyLogPage(start(), forward(0), page([record(11, 'k', NEXT, 'fix')], 11), 0),
      windowStart: 10,
    };
    const older = { kind: 'older', after: 0 } as const;
    const back = applyLogPage(s, older, page([record(9), record(10, 'j', NEXT, 'fix')], 10), 0);
    expect(seqs(back)).toEqual([10, 11]);
    expect(back.windowStart).toBe(0);
    expect(back.wantOlder).toBe(false);
  });

  it('scrolled away, the place holds; back at the end it goes on to the next step', () => {
    const tall = fed(start(), 1, 10);
    const away = scrollLogs(tall, COLS, HEIGHT, -2);
    expect(away.mode).toBe('paused');
    const told = applyLogPage(away, forward(10), page([record(11, 'k', NEXT, 'fix')], 11), 0);
    expect(told.newActivity).toBe(true);
    expect(seqs(told)).toEqual(seqs(away));

    const back = scrollLogs(told, COLS, HEIGHT, 50);
    expect(back.mode).toBe('live');
    const next = applyLogPage(back, forward(10), page([record(11, 'k', NEXT, 'fix')], 11), 0);
    expect(seqs(next)).toEqual([11]);
  });

  it('a gap of an earlier worker does not take the screen back to that step', () => {
    const gap = {
      seq: 4,
      cursor: 3,
      operation_id: 'op',
      attempt_id: ATTEMPT,
      gap: { records: 0, reason: sanitize('waits') },
    } as unknown as Rec;
    const s = applyLogPage(
      start(),
      forward(0),
      page([record(2), record(3, 'c', NEXT, 'fix'), gap], 3),
      0,
    );
    expect(seqs(s)).toEqual([3, 4]);
    expect(latestAttempt(s)).toBe(NEXT);
  });

  it('records outside any attempt stay with the step that follows them', () => {
    const s = applyLogPage(
      start(),
      forward(0),
      page([record(1), record(2, 'b', null, null), record(3, 'c', NEXT, 'fix')], 3),
      0,
    );
    expect(seqs(s)).toEqual([2, 3]);
  });
});

describe('coming back to the end of the log', () => {
  const read = (): LogState =>
    applyLogPage(
      start(),
      forward(0),
      page(
        Array.from({ length: 40 }, (_, i) => record(i + 1)),
        40,
      ),
      0,
    );

  it('follows again after scrolling away, by scrolling down or by the end key', () => {
    const away = scrollLogs(read(), COLS, HEIGHT, -3);
    expect(away.mode).toBe('paused');
    expect(scrollLogs(away, COLS, HEIGHT, 1).mode).toBe('paused');
    expect(scrollLogs(away, COLS, HEIGHT, 3).mode).toBe('live');
    expect(logsEnd(away, COLS, HEIGHT).mode).toBe('live');
  });

  it('keeps a pause that was asked for', () => {
    const paused = scrollLogs(pauseLogs(read(), COLS, HEIGHT), COLS, HEIGHT, -3);
    expect(scrollLogs(paused, COLS, HEIGHT, 3).mode).toBe('paused');
    expect(logsEnd(paused, COLS, HEIGHT).mode).toBe('paused');
  });

  it('stays on one attempt being read', () => {
    const away = { ...scrollLogs(read(), COLS, HEIGHT, -3), attemptFilter: ATTEMPT };
    expect(logsEnd(away, COLS, HEIGHT).mode).toBe('paused');
  });

  it('does not follow past records that are not read yet', () => {
    const away = { ...scrollLogs(read(), COLS, HEIGHT, -3), moreForward: true };
    expect(logsEnd(away, COLS, HEIGHT).mode).toBe('paused');
  });

  it('the top is reached by scrolling too: from following, the end follows again', () => {
    const top = logsTop(fed(start(), 1, 10));
    expect(top.scrolledAway).toBe(true);
    expect(logsEnd(top, COLS, HEIGHT).mode).toBe('live');
    const paused = logsTop(pauseLogs(fed(start(), 1, 10), COLS, HEIGHT));
    expect(paused.scrolledAway).toBe(false);
  });
});

describe('scrolling keeps the place', () => {
  it('going up from live pauses, on the rows just shown', () => {
    const live = fed(start(), 1, 30);
    expect(screenTexts(live).at(-1)).toContain('line 30');
    const s = scrollLogs(live, COLS, HEIGHT, -1);
    expect(s.mode).toBe('paused');
    expect(screenTexts(s).at(-1)).toContain('line 29');
  });

  it('going down stops at the end, without leaving empty rows', () => {
    const paused = pauseLogs(fed(start(), 1, 30), COLS, HEIGHT);
    const s = scrollLogs(paused, COLS, HEIGHT, 50);
    expect(screenTexts(s).at(-1)).toContain('line 30');
    expect(screenTexts(s)).toHaveLength(HEIGHT);
  });

  it('holds while a resize wraps the rows differently', () => {
    const s = scrollLogs(fed(start(), 1, 30), COLS, HEIGHT, -10);
    const narrow = visibleRows(s, 20, HEIGHT);
    expect(narrow.map((r) => r.text).join(' ')).toContain('line 16');
    expect(visibleRows(s, COLS, HEIGHT)[0]?.text).toBe(screenTexts(s)[0]);
  });

  it('up at the top asks for what left the buffer, reads it and keeps the place', () => {
    const live = fed(start(), 1, LOG_BUFFER_RECORDS + 450);
    const top = logsTop(live);
    expect(screenTexts(top)[1]).toContain('line 451');
    const asking = scrollLogs(top, COLS, HEIGHT, -1);
    expect(asking.wantOlder).toBe(true);
    const due = logDue(asking, 0);
    expect(due).toEqual({ kind: 'older', after: 450 - LOG_PAGE_RECORDS });
    const records = Array.from({ length: LOG_PAGE_RECORDS }, (_, i) => record(251 + i));
    const got = applyLogPage(asking, due as never, page(records, 450), 0);
    expect(got.older).toBeNull();
    expect(got.wantOlder).toBe(false);
    expect(got.windowStart).toBe(250);
    expect(got.buffer[0]?.seq).toBe(251);
    // The cap still holds: the newest went, and forward reading goes back for them.
    expect(got.buffer).toHaveLength(LOG_BUFFER_RECORDS);
    expect(got.moreForward).toBe(true);
    expect(got.nextCursor).toBe(got.buffer.at(-1)?.seq);
    // Still where the reader was; one more row up is now there.
    const up = scrollLogs(got, COLS, HEIGHT, -1);
    expect(screenTexts(up)[0]).toContain('line 450');
  });

  it('a page of older records cut short by its bytes is read on to where the buffer starts', () => {
    const live = fed(start(), 1, LOG_BUFFER_RECORDS + 200);
    const asking = scrollLogs(logsTop(live), COLS, HEIGHT, -1);
    const first = applyLogPage(
      asking,
      { kind: 'older', after: 0 },
      page([record(1), record(2)], 2),
      0,
    );
    expect(first.older).not.toBeNull();
    expect(first.buffer[0]?.seq).toBe(201);
    expect(logDue(first, 0)).toEqual({ kind: 'older', after: 2 });
    const records = Array.from({ length: 198 }, (_, i) => record(3 + i));
    const second = applyLogPage(first, { kind: 'older', after: 2 }, page(records, 200), 0);
    expect(second.older).toBeNull();
    expect(second.buffer[0]?.seq).toBe(1);
    expect(second.windowStart).toBe(0);
  });
});

describe('what is on screen', () => {
  it('puts a separator where step or attempt changes, naming both', () => {
    const other = '00000000-0000-7000-8000-000000000a02';
    // Only one attempt's read keeps more than one step, and the daemon sends it one; the rows do not ask.
    const s = applyLogPage(
      { ...start(), attemptFilter: ATTEMPT },
      forward(0),
      page(
        [record(1, 'a'), record(2, 'b'), record(3, 'c', other, 'fix'), record(4, 'd', null, null)],
        4,
      ),
      0,
    );
    const rows = visibleRows(s, COLS, 10);
    expect(rows.filter((r) => r.kind === 'separator').map((r) => r.text)).toEqual([
      '── code · Writing code · attempt 00000a01 ──',
      '── fix · attempt 00000a02 ──',
      '── outside any step ──',
    ]);
    expect(rows[0]?.kind).toBe('separator');
  });

  it('an attempt ID is daemon data like any other', () => {
    const s = applyLogPage(
      start(),
      forward(0),
      page([record(1, 'a', '\x1b[2J\x1b]0;x\x07')], 1),
      0,
    );
    const text = visibleRows(s, COLS, 3)[0]?.text ?? '';
    // eslint-disable-next-line no-control-regex -- the point of the check.
    expect(text).not.toMatch(/[\x00-\x1f]/);
  });

  it('replaces a transient gap after repair and does not keep filling at an unchanged cursor', () => {
    const gap = {
      seq: 1,
      cursor: 0,
      operation_id: 'op',
      attempt_id: ATTEMPT,
      gap: { records: 0, reason: sanitize('live tail unreadable') },
    };
    const s = applyLogPage(start(), forward(0), page([gap], 0), 0);
    expect(screenTexts(s)).toContain('Log temporarily unavailable — live tail unreadable');
    expect(s.filling).toBe(false);
    const repeated = applyLogPage(s, forward(0), page([gap], 0), 1);
    expect(repeated.buffer).toHaveLength(1);
    const repaired = applyLogPage(repeated, forward(0), page([record(1)], 1), 2);
    expect(repaired.buffer).toHaveLength(1);
    expect(repaired.buffer[0]?.gap).toBe(false);
    expect(repaired.nextCursor).toBe(1);
    const older = applyLogPage(
      { ...start(), windowStart: 10, nextCursor: 10, filling: false },
      { kind: 'older', after: 0 },
      page([gap], 0),
      0,
    );
    expect(older.older).toBeNull();
    expect(logDue(older, 0)).toBeNull();
  });

  it('shows a gap as a gap of that size', () => {
    const gap = {
      seq: 7,
      cursor: 7,
      operation_id: 'op',
      attempt_id: ATTEMPT,
      gap: { records: 3, reason: sanitize('files are gone') },
    } as Rec;
    const s = applyLogPage(start(), forward(0), page([gap], 7), 0);
    const rows = visibleRows(s, COLS, 3);
    expect(rows[0]).toMatchObject({
      kind: 'gap',
      text: 'Gap: 3 records unavailable — files are gone',
    });
    expect(s.nextCursor).toBe(7);
  });

  it('wraps a long record without losing any of it', () => {
    const s = applyLogPage(
      start(),
      forward(0),
      page([record(1, 'z'.repeat(200), null, null)], 1),
      0,
    );
    const rows = visibleRows(s, COLS, 10);
    expect(rows.length).toBeGreaterThan(3);
    // Wrapped rows stay under the text, past the two cells of the mark.
    expect(rows.map((r) => r.text.slice(2)).join('')).toContain('z'.repeat(200));
  });

  it('control characters in a record stay as visible stand-ins', () => {
    const s = applyLogPage(start(), forward(0), page([record(1, 'a\x1b[2Jb‮c', null, null)], 1), 0);
    const text = visibleRows(s, COLS, 3)[0]?.text ?? '';
    expect(text).toContain('a␛[2Jb�c');
    // eslint-disable-next-line no-control-regex -- the point of the check.
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f‪-‮]/);
  });
});

describe('records in words', () => {
  const at = sanitize('2026-11-01T10:20:30.000Z');
  const claude = (data: unknown): Rec => ({
    seq: 1,
    cursor: 1,
    operation_id: 'op',
    attempt_id: ATTEMPT,
    step: sanitize('code'),
    at,
    kind: sanitize('stdout'),
    data,
  });

  it("reads an agent's message, a tool call and its result as lines, not JSON", () => {
    const said = toEntry(
      claude({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Running the tests now.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
          ],
        },
      }),
    );
    expect(said?.lines.map((l) => [l.label, l.body])).toEqual([
      ['Agent', 'Running the tests now.'],
      ['Bash', 'pnpm test'],
    ]);
    const result = toEntry(
      claude({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'ok\nmore', is_error: true }],
        },
      }),
    );
    expect(result?.lines[0]).toMatchObject({
      body: 'ok\nmore',
      tone: 'error',
    });
  });

  it('drops what a background task reports while it runs, and says how it ended', () => {
    expect(toEntry(claude({ type: 'tool_progress', tool_name: 'Bash' }))).toBeNull();
    expect(toEntry(claude({ type: 'system', subtype: 'task_started', id: 1 }))).toBeNull();
    expect(
      toEntry(
        claude({
          type: 'system',
          subtype: 'task_notification',
          status: 'completed',
          summary: 'Wait for gates',
        }),
      )?.lines[0],
    ).toMatchObject({ label: 'Task', body: 'Wait for gates (completed)' });
  });

  it('leaves out bookkeeping with nothing to read, and keeps what it does not know', () => {
    expect(toEntry(claude({ type: 'system', subtype: 'thinking_tokens' }))).toBeNull();
    expect(
      toEntry(
        claude({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed' },
        }),
      ),
    ).toBeNull();
    expect(toEntry(claude({ type: 'something_new', x: 1 }))?.text).toContain('something_new');
  });

  it("shows a worker's final JSON answer by its summary", () => {
    const done = toEntry(
      claude({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '{"status":"done","summary":"All three steps ran."}',
        },
      }),
    );
    expect(done?.lines[0]?.body).toBe('All three steps ran.');
  });

  it('a probe that finds only bookkeeping still reports new activity', () => {
    const read = applyLogPage(start(), forward(0), page([record(1)], 1), 0);
    const paused = pauseLogs(read, COLS, HEIGHT);
    const told = applyLogPage(
      paused,
      probe(1),
      page([{ ...claude({ type: 'turn.started' }), seq: 2, cursor: 2 }], 2),
      1,
    );
    expect(told.newActivity).toBe(true);
  });

  it('reads a record it does not know as one line, and keeps its JSON for the full view', () => {
    const system = toEntry(claude({ type: 'system', subtype: 'hook_response', id: 7 }));
    expect(system?.text).toContain('System hook_response');
    expect(system?.text).not.toContain('{');
    expect(system?.lines[0]?.full).toContain('"id":7');
    const s = applyLogPage(
      start(),
      forward(0),
      page([claude({ type: 'system', subtype: 'hook_response', id: 7 })], 1),
      0,
    );
    const shown = (expanded: boolean): string =>
      visibleRows({ ...s, expanded }, 100, 20)
        .map((r) => r.text)
        .join('\n');
    expect(shown(false)).not.toContain('"id":7');
    expect(shown(true)).toContain('"id":7');
    const block = toEntry(
      claude({
        type: 'assistant',
        message: { content: [{ type: 'server_tool_use', name: 'web' }] },
      }),
    );
    expect(block?.text).toContain('server_tool_use');
    expect(block?.lines[0]?.full).toContain('"name":"web"');
    expect(toEntry(claude({ type: 'system', subtype: 'ui_invalidate' }))).toBeNull();
  });

  it('reads as text what the runner wrapped because it was not JSON', () => {
    const line = 'Error: request failed: overloaded';
    const entry = toEntry(claude({ text: line }));
    expect(entry?.text).toContain(line);
    expect(entry?.lines[0]?.label).toBe('');
    expect(entry?.lines[0]?.full).toBeUndefined();
    expect(toEntry(claude({ text: '   ' }))).toBeNull();
    expect(
      toEntry({ ...claude({ text: line }), kind: sanitize('stderr') })?.lines[0],
    ).toMatchObject({
      label: 'stderr',
      tone: 'warn',
    });
  });

  it('a page of bookkeeping only still moves the cursor', () => {
    const s = applyLogPage(
      start(),
      forward(0),
      page([claude({ type: 'system', subtype: 'ui_invalidate' })], 1),
      0,
    );
    expect(s.buffer).toHaveLength(0);
    expect(s.nextCursor).toBe(1);
  });
});

describe('the columns of Logs', () => {
  it('widens the progress column only with room to spare, and drops it when there is none', () => {
    expect(logColumns(99)).toEqual({ pane: 0, log: 99 });
    expect(logColumns(100)).toEqual({ pane: 30, log: 68 });
    expect(logColumns(119)).toEqual({ pane: 30, log: 87 });
    expect(logColumns(120)).toEqual({ pane: 36, log: 82 });
  });

  it('gives the log the whole width on asking, and stays on the same record', () => {
    expect(logColumns(140, true)).toEqual({ pane: 0, log: 140 });
    const held = togglePane({ ...start(), anchor: { seq: 7, row: 3 } });
    expect(held.paneHidden).toBe(true);
    expect(held.anchor).toEqual({ seq: 7, row: 0 });
  });
});

describe("what Logs folds, as a coding agent's transcript does", () => {
  const content = (c: unknown, type = 'assistant'): Rec => ({
    ...record(1),
    kind: sanitize('agent'),
    data: { type, message: { content: [c] } },
  });
  const read = (r: Rec, over: Partial<LogState> = {}): LogState => ({
    ...applyLogPage(start(), forward(0), page([r], 1), 0),
    ...over,
  });
  const body = (s: LogState): string[] =>
    screenTexts(s).filter((t) => t.trim() !== '' && !t.startsWith('──'));
  const output = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
  const result = (is_error: boolean): Rec =>
    content({ type: 'tool_result', is_error, content: output }, 'user');

  it('shows a call on one row, and how much of its result it left out', () => {
    const long = `run ${'x'.repeat(200)}`;
    const call = { type: 'tool_use', name: 'Bash', input: { command: long } };
    expect(body(read(content(call)))).toHaveLength(1);
    expect(body(read(result(false)))).toEqual(['  ⎿  one  +6 lines']);
  });

  it('shows all of it on asking, and stays on the same record', () => {
    const shown = toggleOutput(read(result(false)));
    const whole = visibleRows(shown, COLS, 20).map((r) => r.text.trim().replace('⎿  ', ''));
    expect(whole.slice(-7)).toEqual(output.split('\n'));
    const held = toggleOutput({ ...shown, anchor: { seq: 1, row: 3 } });
    expect(held.expanded).toBe(false);
    expect(held.anchor).toEqual({ seq: 1, row: 0 });
  });

  it('never folds an error, and marks it at the margin', () => {
    const rows = body(read(result(true)));
    expect(rows[0]).toBe('✗ ⎿  one');
    expect(rows.at(-1)?.trim()).toBe('… +3 lines');
    expect(rows).toHaveLength(5);
  });

  it('keeps what the agent says and plain output whole', () => {
    const long = 'word '.repeat(60).trim();
    const said = read(content({ type: 'text', text: long }));
    expect(body(said).length).toBeGreaterThan(1);
    expect(body(read(record(1, long))).length).toBeGreaterThan(1);
  });
});

describe('when the log last moved', () => {
  it('counts bookkeeping too, since a heartbeat says the agent is alive', () => {
    const heartbeat: Rec = {
      ...record(2),
      at: sanitize('2026-11-01T10:25:00.000Z'),
      kind: sanitize('agent'),
      data: { type: 'tool_progress' },
    };
    const s = applyLogPage(start(), forward(0), page([record(1), heartbeat], 2), 0);
    expect(s.buffer).toHaveLength(1);
    expect(s.lastOutputAt).toBe(Date.parse('2026-11-01T10:25:00.000Z'));
  });

  it('does not go back on reading older records', () => {
    const later = sanitize('2026-11-01T11:00:00.000Z');
    const s = applyLogPage(start(), forward(0), page([{ ...record(9), at: later }], 9), 0);
    const again = applyLogPage(s, { kind: 'older', after: 0 }, page([record(1)], 1), 0);
    expect(again.lastOutputAt).toBe(Date.parse(later));
  });
});
