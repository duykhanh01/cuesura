import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { TaskLogs, TaskShow } from '../../../src/tui/client/schemas.ts';
import { initialDetail, onDetailRead, type DetailMessage } from '../../../src/tui/model/detail.ts';
import { onLogsRead, type LogsMessage } from '../../../src/tui/model/detail-keys.ts';
import { initialLogs } from '../../../src/tui/model/logs.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import { Frame } from '../../../src/tui/terminal/screen.ts';
import { logsBody } from '../../../src/tui/views/logs.ts';

// The deputy's runs and turn beside the log come from `task_show`, read again when the log's
// `deputy_stamp` changes: that change moves no task version, so nothing else would read it.
const TASK = '00000000-0000-7000-8000-000000000001';

const show = (mode: 'interactive' | 'headless' | null): TaskShow =>
  ({
    status: 'WAITING',
    version: 4,
    provenance: { usage: [] },
    ...(mode === null ? {} : { deputy: { state: 'running', mode } }),
  }) as unknown as TaskShow;

function opened(): TuiState {
  const title = uiText('A task');
  const detail = initialDetail(TASK, title, 1);
  return {
    ...initialState({ cols: 120, rows: 40 }),
    screens: ['home', 'logs'],
    detail: { ...detail, show: { ...detail.show, data: show('interactive') } },
    logs: { ...initialLogs(TASK, title, 2), tailing: false, deputyStamp: 'before' },
  };
}

const logsPage = (s: TuiState, at: number, stamp: string): LogsMessage => ({
  type: 'logs_read',
  taskId: TASK,
  session: s.logs?.session ?? 0,
  generation: s.logs?.generation ?? 0,
  request: { kind: 'forward', after: 0 },
  at,
  result: {
    ok: true,
    value: {
      task_id: TASK,
      records: [],
      next_cursor: 0,
      complete: false,
      deputy_stamp: stamp,
    } as unknown as TaskLogs,
  },
});

const showRead = (askedAt: number, value: TaskShow): DetailMessage => ({
  type: 'detail_read',
  taskId: TASK,
  session: 1,
  askedAt,
  at: askedAt + 5,
  watermark: null,
  version: 4,
  part: 'show',
  result: { ok: true, value },
});

describe('the deputy beside the log, read again when its stamp changes', () => {
  it('an answer asked before the stamp changed leaves the read wanted; one asked after takes it', () => {
    // A read of task_show is on its way (asked at 100) when the log, asked at 200, brings a new stamp.
    const changed = onLogsRead(opened(), logsPage(opened(), 200, 'after'));
    expect(changed.detail?.showWanted).toBe(true);

    const stale = onDetailRead(changed, showRead(100, show('interactive')));
    expect(stale.detail?.showWanted).toBe(true);
    // The next poll brings the same stamp: the read is still wanted.
    const polled = onLogsRead(stale, logsPage(stale, 300, 'after'));
    expect(polled.detail?.showWanted).toBe(true);

    const fresh = onDetailRead(polled, showRead(400, show(null)));
    expect(fresh.detail?.showWanted).toBe(false);
    expect(fresh.detail?.show.data?.deputy).toBeUndefined();
  });

  it('the first stamp of an opened log asks no read: opening the task already read task_show', () => {
    const fresh = opened();
    const first: TuiState = {
      ...fresh,
      logs: fresh.logs === null ? null : { ...fresh.logs, deputyStamp: null },
    };
    const read = onLogsRead(first, logsPage(first, 200, 'first'));
    expect(read.detail?.showWanted).toBe(false);
    expect(read.logs?.deputyStamp).toBe('first');
    expect(onLogsRead(read, logsPage(read, 300, 'second')).detail?.showWanted).toBe(true);
  });

  it('an answer asked in the same tick as the page with the new stamp leaves the read wanted', () => {
    const changed = onLogsRead(opened(), logsPage(opened(), 200, 'after'));
    const same = onDetailRead(changed, showRead(200, show('interactive')));
    expect(same.detail?.showWanted).toBe(true);
    expect(onDetailRead(same, showRead(201, show(null))).detail?.showWanted).toBe(false);
  });

  it('a turn whose run has no known mode says only that the deputy works, not where its output goes', () => {
    const base = opened();
    const s: TuiState = {
      ...base,
      detail:
        base.detail === null
          ? null
          : {
              ...base.detail,
              show: {
                ...base.detail.show,
                data: { ...show(null), deputy: { state: 'running', mode: null } },
              },
            },
    };
    const frame = new Frame(120, 10, { color: false });
    logsBody(s)(frame, 0, 10);
    const text = stripVTControlCharacters(
      Array.from({ length: 10 }, (_, y) => frame.rowBytes(y)).join('\n'),
    );
    expect(text).toContain('The deputy is working on this task.');
    expect(text).not.toContain('terminal window');
  });
});
