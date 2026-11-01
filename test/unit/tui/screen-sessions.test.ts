import { describe, expect, it } from 'vitest';
import type {
  TaskExplain,
  TaskLogs,
  TaskShow,
} from '../../../src/tui/client/schemas.ts';
import type { LogsMessage } from '../../../src/tui/model/detail-keys.ts';
import {
  detailDue,
  initialDetail,
  type DetailMessage,
} from '../../../src/tui/model/detail.ts';
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

const key = (name: 'esc') =>
  ({ type: 'key', key: { kind: 'key', name } }) as const;
const char = (text: string) =>
  ({ type: 'key', key: { kind: 'char', text } }) as const;

function record(
  seq: number,
  text = `line ${seq}`,
): TaskLogs['records'][number] {
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

function logsAnswer(
  s: TuiState,
  request: LogRequest,
  logPage: TaskLogs,
): LogsMessage {
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

describe('finding 1: a change of token while a read is on its way', () => {
  it('Task detail drops the answer asked under the old token', () => {
    const before = detailOpen();
    const answer = showAnswer(before, 'Read with the old token');
    const after = reduce(before, { type: 'credential_changed' }).state;
    const landed = reduce(after, answer).state;
    expect(landed.detail?.show.data).toBeNull();
  });

  it('still takes the answer to a read asked after the change', () => {
    const after = reduce(detailOpen(), { type: 'credential_changed' }).state;
    const landed = reduce(after, showAnswer(after, 'Read with the new')).state;
    expect(landed.detail?.show.data?.title).toBe('Read with the new');
  });

  it('nothing read under the old token stays on the detail, title included', () => {
    const before = detailOpen();
    const read = reduce(before, showAnswer(before, 'Read with the old')).state;
    const after = reduce(read, { type: 'credential_changed' }).state;
    expect(after.detail?.show.data).toBeNull();
    expect(after.detail?.title).not.toContain('Secret title');
  });

  it('Logs drops the answer asked under the old token, and forgets what it held', () => {
    const open = reduce(detailOpen(), char('l')).state;
    const answer = logsAnswer(
      open,
      { kind: 'forward', after: 0 },
      page([record(1)], 1),
    );
    const held = reduce(open, answer).state;
    expect(held.logs?.buffer).toHaveLength(1);

    const second = logsAnswer(
      held,
      { kind: 'forward', after: 1 },
      page([record(2)], 2),
    );
    const after = reduce(held, { type: 'credential_changed' }).state;
    expect(after.logs?.buffer).toEqual([]);
    expect(after.logs?.nextCursor).toBe(0);
    expect(after.logs?.title).not.toContain('Secret title');
    expect(reduce(after, second).state.logs?.buffer).toEqual([]);
  });
});

describe('finding 2: Logs closed and opened again on the same task', () => {
  it('drops the answer to what the former Logs asked', () => {
    const first = reduce(detailOpen(), char('l')).state;
    const stale = logsAnswer(
      first,
      { kind: 'forward', after: 5_000 },
      page([record(5_001)], 5_001),
    );
    const closed = reduce(first, key('esc')).state;
    const again = reduce(closed, char('l')).state;
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
    const stale = logsAnswer(
      first,
      { kind: 'forward', after: 7 },
      page([record(8)], 8),
    );
    let again = reduce(reduce(first, key('esc')).state, char('l')).state;
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

describe('finding 3: `F` after an attempt, on a log with nothing new', () => {
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

  it('reads a window of the log back, up to where following left off', () => {
    const live = fed(initialLogs(TASK, uiText('T'), 1), 50);
    const filtered = filterAttempt(live, ATTEMPT);
    const back = followLogs(filtered);
    expect(logDue(back, 0)).toEqual({ kind: 'older', after: 0 });
    const read = applyLogPage(
      back,
      { kind: 'older', after: 0 },
      page(
        Array.from({ length: 50 }, (_, i) => record(i + 1)),
        50,
      ),
      0,
    );
    expect(visibleRows(read, 60, 5).at(-1)?.text).toContain('line 50');
    // Then it goes on from the same place: nothing repeated.
    expect(logDue(read, 5_000)).toEqual({ kind: 'forward', after: 50 });
  });

  it('`↑` on an empty buffer with earlier records asks for them', () => {
    const empty: LogState = {
      ...initialLogs(TASK, uiText('T'), 1),
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
      initialLogs(TASK, uiText('T'), 1),
      { kind: 'forward', after: 0 },
      page([record(1, LONG), record(2, 'after it')], 2),
      0,
    );
    // Well into the record: on 80 columns it takes more than ten rows.
    const s = scrollLogs(live, 80, 5, -3);
    expect(s.anchor?.seq).toBe(1);
    expect(s.anchor?.row).toBeGreaterThan(6);
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
