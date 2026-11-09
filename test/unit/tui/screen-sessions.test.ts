import { describe, expect, it } from 'vitest';
import type { BoardRow, TaskExplain, TaskLogs, TaskShow } from '../../../src/tui/client/schemas.ts';
import { openDetail, type LogsMessage } from '../../../src/tui/model/detail-keys.ts';
import { detailDue, initialDetail, type DetailMessage } from '../../../src/tui/model/detail.ts';
import {
  applyLogPage,
  filterAttempt,
  followLogs,
  initialLogs,
  logDue,
  scrollLogs,
  visibleRows,
  type LogRequest,
  type LogState,
} from '../../../src/tui/model/logs.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';

// Findings of the review of T040–T048, each first seen failing here. An answer belongs to the screen that asked:
// nothing that was replaced since may fill the one now open.
const TASK = '00000000-0000-7000-8000-000000000001';
const ATTEMPT = '00000000-0000-7000-8000-000000000a01';

const key = (name: 'esc') => ({ type: 'key', key: { kind: 'key', name } }) as const;
const char = (text: string) => ({ type: 'key', key: { kind: 'char', text } }) as const;

function record(seq: number, text = `line ${seq}`): TaskLogs['records'][number] {
  return {
    seq,
    cursor: seq,
    operation_id: 'op',
    attempt_id: ATTEMPT,
    step: sanitize('code'),
    at: sanitize('2026-11-01T10:20:30.000Z'),
    kind: sanitize('progress'),
    data: text,
  };
}

const page = (records: TaskLogs['records'], next: number): TaskLogs =>
  ({ task_id: TASK, records, next_cursor: next, complete: false }) as TaskLogs;

/** Task detail open, as Enter on Home leaves it. */
function detailOpen(): TuiState {
  return {
    ...initialState({ cols: 100, rows: 30 }),
    connection: { kind: 'online' },
    screens: ['home', 'detail'],
    detail: initialDetail(TASK, uiText('Secret title'), 1),
    screenSession: 1,
  };
}

/** The answer a read started now would bring, whenever it lands. */
function showAnswer(s: TuiState, title: string): DetailMessage {
  return {
    type: 'detail_read',
    taskId: TASK,
    session: s.detail?.session,
    at: 1_000,
    askedAt: 900,
    watermark: 1,
    version: 1,
    part: 'show',
    result: {
      ok: true,
      value: { title: sanitize(title), version: 1 } as TaskShow,
    },
  } as DetailMessage;
}

function logsAnswer(s: TuiState, request: LogRequest, logPage: TaskLogs): LogsMessage {
  const logs = s.logs as LogState;
  return {
    type: 'logs_read',
    taskId: TASK,
    session: logs.session,
    generation: logs.generation,
    request,
    at: 1_000,
    result: { ok: true, value: logPage },
  };
}

/** Enter on the task's row of Home. */
const reopen = (s: TuiState): TuiState =>
  openDetail(s, { kind: 'task', task: { task_id: TASK, title: uiText('T') } as BoardRow }).state;

describe('finding 2: Logs closed and opened again on the same task', () => {
  it('drops the answer to what the former Logs asked', () => {
    const first = reduce(detailOpen(), char('l')).state;
    const stale = logsAnswer(
      first,
      { kind: 'forward', after: 5_000 },
      page([record(5_001)], 5_001),
    );
    const again = reopen(reduce(first, key('esc')).state);
    const landed = reduce(again, stale).state;
    expect(landed.logs?.buffer).toEqual([]);
    expect(landed.logs?.nextCursor).toBe(0);
  });

  it('does so however many times the former one changed what it read', () => {
    let first = reduce(detailOpen(), char('l')).state;
    first = {
      ...first,
      logs: followLogs(filterAttempt(first.logs as LogState, ATTEMPT)),
    };
    const stale = logsAnswer(first, { kind: 'forward', after: 7 }, page([record(8)], 8));
    let again = reopen(reduce(first, key('esc')).state);
    again = {
      ...again,
      logs: followLogs(filterAttempt(again.logs as LogState, ATTEMPT)),
    };
    expect(reduce(again, stale).state.logs?.buffer).toEqual([]);
  });

  it('Task detail closed and opened again drops its former answers too', () => {
    const first = detailOpen();
    const stale = showAnswer(first, 'From the former screen');
    const home = reduce(first, key('esc')).state;
    const again: TuiState = {
      ...home,
      screens: ['home', 'detail'],
      detail: initialDetail(TASK, uiText('T'), home.screenSession + 1),
      screenSession: home.screenSession + 1,
    };
    expect(reduce(again, stale).state.detail?.show.data).toBeNull();
  });
});

describe('finding 3: `Space` after an attempt, on a log with nothing new', () => {
  const fed = (s: LogState, count: number): LogState =>
    applyLogPage(
      s,
      { kind: 'forward', after: 0 },
      page(
        Array.from({ length: count }, (_, i) => record(i + 1)),
        count,
      ),
      0,
    );

  it('reads the last page of the whole log back, then follows from its end', () => {
    const live = fed({ ...initialLogs(TASK, uiText('T'), 1), tailing: false }, 50);
    const filtered = filterAttempt(live, ATTEMPT);
    const back = followLogs(filtered);
    expect(logDue(back, 0)).toEqual({ kind: 'tail', after: 0 });
    const read = applyLogPage(
      back,
      { kind: 'tail', after: 0 },
      {
        ...page(
          Array.from({ length: 50 }, (_, i) => record(i + 1)),
          50,
        ),
        after: 0,
      },
      0,
    );
    expect(visibleRows(read, 60, 5).at(-1)?.text).toContain('line 50');
    // Then it goes on from the same place: nothing repeated.
    expect(logDue(read, 5_000)).toEqual({ kind: 'forward', after: 50 });
  });

  it('`↑` on an empty buffer with earlier records asks for them', () => {
    const empty: LogState = {
      ...{ ...initialLogs(TASK, uiText('T'), 1), tailing: false },
      windowStart: 300,
      nextCursor: 300,
    };
    const asked = scrollLogs(empty, 60, 5, -1);
    expect(asked.wantOlder).toBe(true);
    expect(logDue(asked, 0)).toEqual({ kind: 'older', after: 100 });
  });
});

describe('finding 4: paused inside a wrapped record, then a wider terminal', () => {
  const LONG = 'x'.repeat(1_000);
  const paused = (): LogState => {
    const live = applyLogPage(
      { ...initialLogs(TASK, uiText('T'), 1), tailing: false },
      { kind: 'forward', after: 0 },
      page([record(1, LONG), record(2, 'after it')], 2),
      0,
    );
    // Well into the record: on 80 columns it takes more than ten rows.
    const s = scrollLogs(live, 80, 5, -3);
    expect(s.anchor).toMatchObject({ seq: 1 });
    expect((s.anchor as { row: number }).row).toBeGreaterThan(6);
    return s;
  };

  it('still shows that record, not what comes after or nothing', () => {
    const rows = visibleRows(paused(), 200, 5);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.text).toContain('xxx');
  });

  it('scrolls from there in both directions', () => {
    const s = paused();
    const up = scrollLogs(s, 200, 5, -1);
    expect(visibleRows(up, 200, 5)[0]?.text).toContain('xxx');
    const down = scrollLogs(s, 200, 2, 1);
    expect(
      visibleRows(down, 200, 2)
        .map((r) => r.text)
        .join(),
    ).toContain('after it');
  });
});

describe('finding 5: the 5 seconds of `task_explain` run from when it was asked', () => {
  const explained = (askedAt: number, at: number): TuiState => {
    const s = detailOpen();
    return reduce(s, {
      type: 'detail_read',
      taskId: TASK,
      session: s.detail?.session,
      at,
      askedAt,
      watermark: 1,
      version: 1,
      part: 'explain',
      result: { ok: true, value: { version: 1 } as TaskExplain },
    } as DetailMessage).state;
  };

  it('an answer that took a second does not stretch the period', () => {
    const s = explained(0, 1_000);
    const d = s.detail as NonNullable<TuiState['detail']>;
    expect(detailDue(d, 1, 4_499)).not.toContain('explain');
    expect(detailDue(d, 1, 4_500)).toContain('explain');
  });

  it('what the screen says it read is when the answer came', () => {
    expect(explained(0, 1_000).detail?.explain.readAt).toBe(1_000);
  });
});
