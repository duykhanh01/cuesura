import { describe, expect, it } from 'vitest';
import type { BoardReply, Health } from '../../../src/tui/client/schemas.ts';
import { MutationTracker, type MutationPort } from '../../../src/tui/client/mutations.ts';
import type { HomeRow } from '../../../src/tui/model/home-rows.ts';
import { openDetail } from '../../../src/tui/model/detail-keys.ts';
import { initialDetail } from '../../../src/tui/model/detail.ts';
import type { Message } from '../../../src/tui/model/messages.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { initialState, writeLock, type TuiState } from '../../../src/tui/model/state.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import { actionsShowDue, openActions } from '../../../src/tui/model/actions.ts';
import { flat, recheckScene, sendRecheck, useTui } from '../../support/tui-fixtures.ts';

// T056: no write goes out on stale data, and a draft survives it without being sent (US4 scenario 10,
// SC-015, FR-044). The first block drives the Actions screen on a PTY, opened straight from Home; the second
// checks the lock as a function of state, which is what the rest of the screens rely on.
const tui = useTui();
const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';
const HEALTH: Health = { healthy: true, reason: null, slots: [], concurrency: 1, queue_length: 0 };
const BOARD = {
  unchanged: false,
  watermark: 1,
  counts: { by_status: {} },
  queue: { length: 0 },
  attention: { items: [], truncated: false },
  items: [],
  next_cursor: null,
} as unknown as BoardReply;

const succeeded: Message = { type: 'read_succeeded', board: BOARD, health: HEALTH, at: 1 };
const failed: Message = { type: 'read_failed', failure: { ok: false, permanent: null } };
const detailOk = (taskId: string, session: number): Message => ({
  type: 'detail_read',
  taskId,
  session,
  askedAt: 1,
  at: 2,
  watermark: null,
  version: null,
  part: 'show',
  result: { ok: true, value: {} as never },
});

function step(s: TuiState, ...ms: Message[]) {
  const effects: unknown[] = [];
  for (const m of ms) {
    const r = reduce(s, m);
    s = r.state;
    effects.push(...r.effects);
  }
  return { s, effects };
}

const withDetail = (s: TuiState, id: string): TuiState => ({
  ...s,
  detail: initialDetail(id, uiText('t'), 7),
});

describe('US4 scenario 10: the Actions screen on stale data', () => {
  it('sends nothing while stale or until the task is read again, then sends once', async () => {
    const { proxy, s, sent, control, observed } = await recheckScene(tui);
    const said = (text: string): Promise<void> =>
      s.waitFor(() => flat(s.screenText()).includes(text), 10_000);

    // The link goes: Home is stale, and Enter on Recheck says why nothing was sent.
    control.refuseAll = true;
    proxy.dropConnections();
    await said('Reconnecting');
    await sendRecheck(s);
    await said('Nothing was sent: the data on screen may be out of date');
    expect(sent).toHaveLength(0);

    // The link is back but the task is not read yet: Home is fresh, the task is not.
    control.refuseTaskShow = true;
    control.refuseAll = false;
    await s.waitFor(() => !flat(s.screenText()).includes('Reconnecting'), 15_000);
    await sendRecheck(s);
    await said('being read again after the connection came back');
    expect(sent).toHaveLength(0);

    // The first `task_show` after the recovery answers: the write goes out, once.
    control.refuseTaskShow = false;
    for (let i = 0; i < 30 && sent.length === 0; i++) {
      await sendRecheck(s);
      await new Promise((r) => setTimeout(r, 300));
    }
    await said('Done (request');
    expect(sent).toHaveLength(1);
    expect(observed()).toBe(1);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 40_000);
});

describe('US4 scenario 10: stale data locks writes', () => {
  it('locks everything before the first read and unlocks after it', () => {
    const s0 = initialState({ cols: 100, rows: 30 });
    expect(writeLock(s0, A)).toBe('stale');
    expect(writeLock(step(s0, succeeded).s, A)).toBeNull();
  });

  it('locks every task while Home is stale, and a good read unlocks them', () => {
    const { s } = step(initialState({ cols: 100, rows: 30 }), succeeded, failed);
    expect(writeLock(s, A)).toBe('stale');
    expect(writeLock(s, B)).toBe('stale');
    expect(writeLock(step(s, succeeded).s, A)).toBeNull();
  });

  it('locks only the task whose detail read failed, until it reads again', () => {
    const { s: online } = step(initialState({ cols: 100, rows: 30 }), succeeded);
    const open = withDetail(online, A);
    const bad = reduce(open, {
      type: 'detail_read',
      taskId: A,
      session: 7,
      askedAt: 1,
      at: 2,
      watermark: null,
      version: null,
      part: 'show',
      result: { ok: false, error: { kind: 'connection', message: uiText('gone') } },
    }).state;
    expect(writeLock(bad, A)).toBe('task_stale');
    expect(writeLock(bad, B)).toBeNull();
    expect(writeLock(reduce(bad, detailOk(A, 7)).state, A)).toBeNull();
  });

  it('after recovery re-reads the open task before unlocking it', () => {
    const base = withDetail(step(initialState({ cols: 100, rows: 30 }), succeeded).s, A);
    const { s, effects } = step(base, failed, succeeded);
    expect(effects).toContainEqual({ type: 'read_screen' });
    expect(writeLock(s, A)).toBe('task_stale');
    expect(writeLock(s, B)).toBeNull();
    expect(writeLock(reduce(s, detailOk(A, 7)).state, A)).toBeNull();
  });

  it('ignores a detail read asked before recovery and a good read of another part', () => {
    const base = withDetail(step(initialState({ cols: 100, rows: 30 }), succeeded).s, A);
    const { s } = step(base, failed, { ...succeeded, at: 100 });
    expect(s.detail?.showWanted).toBe(true);
    const old = reduce(s, { ...(detailOk(A, 7) as object), askedAt: 50 } as Message).state;
    expect(writeLock(old, A)).toBe('task_stale');
    expect(old.detail?.showWanted).toBe(true);
    const other = reduce(s, {
      ...(detailOk(A, 7) as object),
      part: 'progress',
      askedAt: 150,
    } as Message).state;
    expect(writeLock(other, A)).toBe('task_stale');
    const fresh = reduce(s, { ...(detailOk(A, 7) as object), askedAt: 150 } as Message).state;
    expect(writeLock(fresh, A)).toBeNull();
  });

  it('keeps a stale task locked when it is reopened and another part answers first', () => {
    const { s: online } = step(initialState({ cols: 100, rows: 30 }), succeeded);
    const stale: TuiState = { ...online, staleTasks: new Set([A]) };
    const row = { kind: 'task', task: { task_id: A, title: uiText('t') } } as unknown as HomeRow;
    const reopened = openDetail(stale, row).state;
    const session = reopened.detail?.session ?? 0;
    const progress = {
      ...(detailOk(A, session) as object),
      part: 'progress',
      result: { ok: true, value: {} },
    } as Message;
    const other = reduce(reopened, progress).state;
    expect(writeLock(other, A)).toBe('task_stale');
    expect(writeLock(reduce(other, detailOk(A, session)).state, A)).toBeNull();
  });

  it('locks the task of an Actions menu opened from Home, which has no detail, until task_show answers', () => {
    const online = step(initialState({ cols: 100, rows: 30 }), succeeded).s;
    const opened = openActions(online, A, uiText('t')).state;
    expect(opened.detail).toBeNull();
    const session = opened.actions?.session ?? 0;
    const { s, effects } = step(opened, failed, { ...succeeded, at: 100 });
    expect(effects).toContainEqual({ type: 'read_screen' });
    expect(s.actions?.showWanted).toBe(true);
    expect(writeLock(s, A)).toBe('task_stale');
    const show = (askedAt: number): Message => ({
      type: 'actions_show_read',
      taskId: A,
      session,
      askedAt,
      at: askedAt + 1,
      watermark: null,
      result: { ok: true, value: { project: 'acme', version: 7 } as never },
    });
    expect(writeLock(reduce(s, show(50)).state, A)).toBe('task_stale');
    expect(writeLock(reduce(s, show(150)).state, A)).toBeNull();
  });

  it('frees the task when Actions is opened from Detail, a read failed, and a later task_show answers', () => {
    const online = withDetail(step(initialState({ cols: 100, rows: 30 }), succeeded).s, A);
    const opened = openActions(online, A, uiText('t')).state;
    const session = opened.actions?.session ?? 0;
    const show = (ok: boolean): Message => ({
      type: 'actions_show_read',
      taskId: A,
      session,
      askedAt: 10,
      at: 11,
      watermark: null,
      result: ok
        ? { ok: true, value: { project: 'acme', version: 7 } as never }
        : { ok: false, error: { kind: 'connection', message: uiText('x') } },
    });
    const failedRead = reduce(opened, show(false)).state;
    expect(writeLock(failedRead, A)).toBe('task_stale');
    expect(writeLock(reduce(failedRead, show(true)).state, A)).toBeNull();
  });

  it('waits after a failed task_show before asking again, and keeps the lock', () => {
    const online = step(initialState({ cols: 100, rows: 30 }), succeeded).s;
    const opened = openActions(online, A, uiText('t')).state;
    const session = opened.actions?.session ?? 0;
    const failedShow: Message = {
      type: 'actions_show_read',
      taskId: A,
      session,
      askedAt: 1_000,
      at: 1_001,
      watermark: null,
      result: { ok: false, error: { kind: 'connection', message: uiText('x') } },
    };
    const s = reduce(
      { ...opened, actions: { ...opened.actions!, showWanted: true } },
      failedShow,
    ).state;
    expect(actionsShowDue(s.actions!, null, 1_100)).toBe(false);
    expect(actionsShowDue(s.actions!, null, 1_000 + 60_000)).toBe(true);
    expect(writeLock(s, A)).toBe('task_stale');
  });

  it('keeps a draft in memory through stale and recovery without sending it', () => {
    const base = withDetail(step(initialState({ cols: 100, rows: 30 }), succeeded).s, A);
    const typed = reduce(base, { type: 'draft_changed', taskId: A, text: 'my answer' }).state;
    const { s, effects } = step(typed, failed, succeeded);
    expect(s.drafts.get(A)).toBe('my answer');
    expect(effects.every((e) => (e as { type: string }).type !== 'send')).toBe(true);
    expect(reduce(s, { type: 'draft_changed', taskId: A, text: null }).state.drafts.has(A)).toBe(
      false,
    );
  });

  it('still reconciles an unknown write while data is stale', async () => {
    const shows: string[] = [];
    const port: MutationPort = {
      command: () =>
        Promise.resolve({ ok: false, error: { kind: 'connection', message: uiText('x') } }),
      requestShow: (id) => {
        shows.push(id);
        return Promise.resolve({ ok: false, error: { kind: 'connection', message: uiText('x') } });
      },
    };
    const tracker = new MutationTracker({ port, connected: () => true, newId: () => 'r1' });
    await tracker.submit({
      kind: 'task_cancel',
      project: 'acme',
      task_id: A,
      expected_version: 1,
      payload: {},
    });
    const stale = step(initialState({ cols: 100, rows: 30 }), failed).s;
    expect(writeLock(stale, A)).toBe('stale');
    await tracker.poll('r1');
    expect(shows).toEqual(['r1']);
  });
});
