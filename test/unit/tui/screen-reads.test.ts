import { describe, expect, it } from 'vitest';
import type { DaemonPort, PortResult } from '../../../src/tui/client/daemon-port.ts';
import {
  planScreenReads,
  ScreenReads,
  type ScreenRead,
} from '../../../src/tui/client/screen-reads.ts';
import type { RefreshClock } from '../../../src/tui/client/refresh.ts';
import type {
  TaskContent,
  TaskExplain,
  TaskHistory,
  TaskProgress,
  TaskShow,
} from '../../../src/tui/client/schemas.ts';
import {
  contentDue,
  detailDue,
  initialDetail,
  onDetailRead,
  type DetailMessage,
  type TaskDetail,
} from '../../../src/tui/model/detail.ts';
import { initialLogs } from '../../../src/tui/model/logs.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';

// T044: when the open screen reads, with the clock in the test's hand (R-03).
const TASK = '00000000-0000-7000-8000-000000000001';
const WM = 100;

const explain = (version: number): PortResult<TaskExplain> => ({
  ok: true,
  value: { version } as TaskExplain,
});
const show = (version: number): PortResult<TaskShow> => ({
  ok: true,
  value: { version } as TaskShow,
});
const progress = (version: number): PortResult<TaskProgress> => ({
  ok: true,
  value: { version } as TaskProgress,
});
const history = (next: number): PortResult<TaskHistory> => ({
  ok: true,
  value: {
    task_id: TASK,
    events: [],
    next_cursor: next,
    more: false,
  } as unknown as TaskHistory,
});

const open = (over: Partial<TuiState> = {}): TuiState => ({
  ...initialState({ cols: 100, rows: 30 }),
  connection: { kind: 'online' },
  screens: ['home', 'detail'],
  detail: initialDetail(TASK, uiText('Task'), 1),
  ...over,
});

const base = { type: 'detail_read', taskId: TASK, session: 1 } as const;

/** Everything read once at `at`, under this watermark and version. */
function read(s: TuiState, at: number, watermark: number, version: number): TuiState {
  const common = { ...base, at, askedAt: at, watermark, version };
  const messages: DetailMessage[] = [
    { ...common, part: 'explain', result: explain(version) },
    { ...common, part: 'show', result: show(version) },
    { ...common, part: 'progress', result: progress(version) },
    { ...common, part: 'history', result: history(version) },
  ];
  return messages.reduce(onDetailRead, s);
}

const detail = (s: TuiState): TaskDetail => s.detail as TaskDetail;

describe('T044: when Task detail reads (R-03)', () => {
  it('reads everything on opening', () => {
    expect(detailDue(detail(open()), WM, 0)).toEqual(['explain', 'show', 'progress', 'history']);
  });

  it('then nothing, while nothing moved and 5 seconds have not passed', () => {
    const s = read(open(), 1_000, WM, 7);
    expect(detailDue(detail(s), WM, 5_499)).toEqual([]);
  });

  it('`task_explain` at least every 5 seconds, alone', () => {
    const s = read(open(), 1_000, WM, 7);
    expect(detailDue(detail(s), WM, 5_500)).toEqual(['explain']);
  });

  it('`task_explain` when the watermark moved, however soon, alone while the version stands', () => {
    const s = read(open(), 1_000, WM, 7);
    expect(detailDue(detail(s), WM + 1, 1_100)).toEqual(['explain']);
    const again = onDetailRead(s, {
      ...base,
      at: 1_200,
      askedAt: 1_200,
      watermark: WM + 1,
      version: 7,
      part: 'explain',
      result: explain(7),
    });
    expect(detailDue(detail(again), WM + 1, 1_300)).toEqual([]);
  });

  it('`task_show`, `task_progress` and the history when the version moved', () => {
    const s = read(open(), 1_000, WM, 7);
    const moved = onDetailRead(s, {
      ...base,
      at: 1_200,
      askedAt: 1_200,
      watermark: WM + 1,
      version: 7,
      part: 'explain',
      result: explain(8),
    });
    expect(detailDue(detail(moved), WM + 1, 1_300)).toEqual(['show', 'progress', 'history']);
  });

  it('a read that failed is tried again every 5 seconds, not every tick, and locks the task', () => {
    const failed = onDetailRead(open(), {
      ...base,
      at: 1_000,
      askedAt: 1_000,
      watermark: WM,
      version: null,
      part: 'show',
      result: {
        ok: false,
        error: { kind: 'timeout', message: sanitize('slow') },
      },
    });
    expect(failed.staleTasks.has(TASK)).toBe(true);
    expect(detailDue(detail(failed), WM, 1_100)).not.toContain('show');
    expect(detailDue(detail(failed), WM, 5_500)).toContain('show');
    const fine = read(failed, 6_000, WM, 7);
    expect(fine.staleTasks.has(TASK)).toBe(false);
  });

  it('drops an answer for a task no longer open', () => {
    const s = open({ detail: initialDetail('another', uiText('Other'), 1) });
    expect(read(s, 1, WM, 7)).toBe(s);
  });

  it('keeps a bounded history and counts what left it', () => {
    let s = open();
    for (let i = 0; i < 3; i++)
      s = onDetailRead(s, {
        ...base,
        at: i,
        askedAt: i,
        watermark: WM,
        version: 7,
        part: 'history',
        result: {
          ok: true,
          value: {
            task_id: TASK,
            events: Array.from({ length: 1_000 }, (_, n) => ({
              seq: i * 1_000 + n + 1,
              type: sanitize('Event'),
              revision: 1,
              actor: sanitize('me'),
              payload: { long: 'x'.repeat(1_000) },
            })),
            next_cursor: (i + 1) * 1_000,
            more: i < 2,
          } as unknown as TaskHistory,
        },
      });
    expect(detail(s).history.events).toHaveLength(2_000);
    expect(detail(s).history.dropped).toBe(1_000);
    expect(detail(s).history.events[0]?.seq).toBe(1_001);
    expect(detail(s).history.events[0]?.payload.length).toBeLessThan(500);
  });
});

describe('when Task detail reads what the task asks for (FR-015.01)', () => {
  const content = (revision: number): DetailMessage => ({
    ...base,
    at: 1_000,
    askedAt: 1_000,
    watermark: WM,
    version: 7,
    part: 'content',
    result: { ok: true, value: { revision } as TaskContent },
  });
  const explainAt = (revision: number): DetailMessage => ({
    ...base,
    at: 1_100,
    askedAt: 1_100,
    watermark: WM,
    version: 7,
    part: 'explain',
    result: { ok: true, value: { version: 7, revision } as TaskExplain },
  });

  it('reads it on opening, then only when the revision moves', () => {
    expect(contentDue(detail(open()), 0)).toBe(true);
    const s = onDetailRead(onDetailRead(open(), content(1)), explainAt(1));
    expect(contentDue(detail(s), 60_000)).toBe(false);
    expect(contentDue(detail(onDetailRead(s, explainAt(2))), 1_200)).toBe(true);
  });

  it('a failed read is tried again every 5 seconds and does not lock writes', () => {
    const failed = onDetailRead(open(), {
      ...content(1),
      result: { ok: false, error: { kind: 'timeout', message: sanitize('slow') } },
    });
    expect(failed.staleTasks.has(TASK)).toBe(false);
    expect(contentDue(detail(failed), 1_100)).toBe(false);
    expect(contentDue(detail(failed), 5_500)).toBe(true);
  });
});

const fakePort = (log: string[]): DaemonPort =>
  ({
    show: () => (log.push('show'), Promise.resolve(show(1))),
    progress: () => (log.push('progress'), Promise.resolve(progress(1))),
    explain: () => (log.push('explain'), Promise.resolve(explain(1))),
    history: () => (log.push('history'), Promise.resolve(history(0))),
    logs: () => (
      log.push('logs'),
      Promise.resolve({
        ok: true,
        value: { task_id: TASK, records: [], next_cursor: 0, complete: false },
      })
    ),
  }) as unknown as DaemonPort;

const stoppedClock: RefreshClock = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  now: () => 0,
};

const plan = (s: TuiState): string[] =>
  planScreenReads(s, fakePort([]), stoppedClock, 0).map((r: ScreenRead) => r.key);

describe('only the open screen reads (R-03)', () => {
  it('Home reads nothing of its own', () => {
    expect(plan(open({ screens: ['home'], detail: null }))).toEqual([]);
  });

  it('Task detail reads the show again when asked to, even if the version has not moved', () => {
    const s = open({ screens: ['home', 'detail'] });
    const wanted = { ...s, detail: { ...s.detail!, showWanted: true } };
    expect(plan(wanted)).toContain('detail:show');
  });

  it('Task detail reads what the task asks for', () => {
    expect(plan(open())).toContain('detail:content');
  });

  it('Help over Task detail reads nothing', () => {
    expect(plan(open({ screens: ['home', 'detail', 'help'] }))).toEqual([]);
  });

  it('Logs reads the log and what its stages need, not yet the history', () => {
    const keys = plan(
      open({
        screens: ['home', 'logs'],
        logs: initialLogs(TASK, uiText('T'), 1),
      }),
    );
    expect(keys[0]).toBe('logs');
    expect(keys).toContain('detail:progress');
    expect(keys).not.toContain('detail:history');
    expect(keys).not.toContain('detail:content');
  });

  it('Logs over an ended task reads the history too: its end is told from there', () => {
    const logs = { screens: ['home', 'logs'], logs: initialLogs(TASK, uiText('T'), 1) };
    const ended = (status: string): TuiState =>
      onDetailRead(open(logs as Partial<TuiState>), {
        ...base,
        at: 0,
        askedAt: 0,
        watermark: WM,
        version: 1,
        part: 'explain',
        result: { ok: true, value: { version: 1, status } as TaskExplain },
      });
    expect(plan(ended('CANCELLED'))).toContain('detail:history');
    expect(plan(ended('FAILED'))).toContain('detail:history');
    expect(plan(ended('RUNNING'))).not.toContain('detail:history');
    expect(plan(ended('DONE'))).not.toContain('detail:history');
  });

  it.each([
    { kind: 'connecting' },
    { kind: 'reconnecting', attempt: 2 },
    { kind: 'waiting_retry' },
  ] as const)('nothing while the connection is $kind', (connection) => {
    expect(plan(open({ connection }))).toEqual([]);
    expect(
      plan(
        open({
          connection,
          screens: ['home', 'logs'],
          logs: initialLogs(TASK, uiText('T'), 1),
        }),
      ),
    ).toEqual([]);
  });
});

describe('ScreenReads', () => {
  it('runs one read of a kind at a time and looks again after each answer', async () => {
    const answers: (() => void)[] = [];
    let runs = 0;
    const planned: ScreenRead[] = [
      {
        key: 'a',
        run: () => {
          runs += 1;
          return new Promise((resolve) =>
            answers.push(() => resolve({ type: 'resize', size: { cols: 1, rows: 1 } })),
          );
        },
      },
    ];
    let looks = 0;
    const reports: unknown[] = [];
    const reads = new ScreenReads({
      clock: stoppedClock,
      plan: () => {
        looks += 1;
        return looks > 3 ? [] : planned;
      },
      report: (m) => reports.push(m),
    });
    reads.start();
    reads.kick();
    reads.kick();
    expect(runs).toBe(1);
    answers.shift()?.();
    await new Promise((r) => setImmediate(r));
    expect(reports).toHaveLength(1);
    expect(looks).toBe(4);
    reads.stop();
  });

  it('reports nothing after it stopped', async () => {
    const reports: unknown[] = [];
    let answer: () => void = () => undefined;
    const reads = new ScreenReads({
      clock: stoppedClock,
      plan: () => [
        {
          key: 'a',
          run: () =>
            new Promise(
              (resolve) => (answer = () => resolve({ type: 'resize', size: { cols: 1, rows: 1 } })),
            ),
        },
      ],
      report: (m) => reports.push(m),
    });
    reads.start();
    reads.stop();
    answer();
    await new Promise((r) => setImmediate(r));
    expect(reports).toEqual([]);
  });
});
