import { describe, expect, it } from 'vitest';
import type { BoardReply, Health } from '../../../src/tui/client/schemas.ts';
import {
  COMMAND_TIMEOUT_MS,
  MutationTracker,
  type MutationCommand,
  type MutationPort,
} from '../../../src/tui/client/mutations.ts';
import type { HomeRow } from '../../../src/tui/model/home-rows.ts';
import { openDetail } from '../../../src/tui/model/detail-keys.ts';
import { initialDetail } from '../../../src/tui/model/detail.ts';
import type { Message } from '../../../src/tui/model/messages.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { initialState, writeLock, type TuiState } from '../../../src/tui/model/state.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import { actionsShowDue, openActions } from '../../../src/tui/model/actions.ts';
import {
  chars,
  explainOf,
  inboxMessage,
  key,
  menu,
  OWNER,
  QUESTION,
  TASK,
  run,
  sentCommand,
  submits,
  text,
} from '../../support/tui-dialogs.ts';
import { uuidOf } from '../../support/builders.ts';
import { KEY } from '../../support/pty.ts';
import {
  flat,
  pressAction,
  recheckScene,
  sendRecheck,
  taskAdd,
  useTui,
} from '../../support/tui-fixtures.ts';

// T056: no write goes out on stale data, and a draft survives it without being sent (US4 scenario 10,
// SC-015, FR-044). The first block drives the Actions screen on a PTY, opened straight from Home; the second
// checks the lock as a function of state, which is what the rest of the screens rely on.
const tui = useTui();
const ids = (sent: { id: string }[]): string[] => [...new Set(sent.map((x) => x.id))];
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
  it('on stale data keeps checking an unknown write to its end, keeps a typed reason, and sends nothing new', async () => {
    const { sd, s, sent, control, holdDaemon, release, shows } = await recheckScene(tui);
    const said = (text: string, ms = 10_000): Promise<void> =>
      s.waitFor(() => flat(s.screenText()).includes(text), ms);
    holdDaemon();
    try {
      // The daemon keeps the Recheck in progress: its answer times out and the write is unknown.
      await sendRecheck(s);
      await said('Result unknown - checking', COMMAND_TIMEOUT_MS + 5_000);
      // Board reads fail while the daemon is still reachable: everything on screen is stale.
      control.refuseBoard = true;
      await said('Reconnecting');

      // A reason typed for Cancel survives leaving and reopening the dialog, and is not sent.
      await pressAction(s, 'Cancel task');
      await s.waitForText('Reason');
      s.send('keep this reason');
      await s.waitForText('keep this reason');
      s.send(KEY.esc);
      await s.waitFor(() => !s.screenText().includes('keep this reason'));
      await pressAction(s, 'Cancel task');
      await s.waitForText('keep this reason');
      s.send(KEY.tab);
      s.send('cancel');
      s.send(KEY.enter);
      await said('Nothing was sent');
      s.send(KEY.esc);
    } finally {
      release();
    }
    // Still stale, the lookup goes on and finds the stored result.
    const before = shows();
    await said('Done (request', 20_000);
    expect(flat(s.screenText())).toContain('Reconnecting');
    expect(shows()).toBeGreaterThan(before);
    expect(ids(sent)).toHaveLength(1);
    const history = await sd.query('owner', { kind: 'task_history', task_id: uuidOf(1) });
    const events = history.envelope.data?.['events'] as { type: string }[];
    expect(events.filter((e) => e.type === 'TaskCancelled')).toHaveLength(0);
    control.refuseBoard = false;
    s.send('q');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 60_000);
});

describe('US4 scenario 10: a failed task read while a dialog is open', () => {
  it('sends nothing until task_explain answers again, then sends once', async () => {
    const { sd, s, sent, control, observed } = await recheckScene(tui);
    await pressAction(s, 'Recheck');
    await s.waitForText('Ctrl-S sends');
    // Anything new on the board makes the menu read task_explain again; that read fails, Home stays online.
    control.refuseExplain = true;
    await sd.command('owner', taskAdd(1, 'Another task'));
    await s.waitFor(() => control.explainRefused > 0, 15_000);
    s.send(KEY.ctrlS);
    await s.waitFor(() => flat(s.screenText()).includes('could not be read just now'));
    expect(flat(s.screenText())).not.toContain('Reconnecting');
    expect(sent).toHaveLength(0);

    control.refuseExplain = false;
    for (let i = 0; i < 40 && sent.length === 0; i++) {
      s.send(KEY.ctrlS);
      await new Promise((r) => setTimeout(r, 300));
    }
    await s.waitFor(() => /Done \(request /.test(s.screenText()), 10_000);
    expect(ids(sent)).toHaveLength(1);
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

  it('keeps what was typed through stale data, a refusal, Esc and reopening, and never sends it alone', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    const typed = run(open, ...chars('my reason')).state;

    // Stale while typing: the text stays and confirming sends nothing.
    const stale = run(typed, failed, key('tab'), ...chars('cancel'), key('enter'));
    expect(submits(stale.effects)).toHaveLength(0);
    expect(stale.state.dialog?.field?.text).toBe('my reason');
    const back = run(stale.state, succeeded);
    expect(submits(back.effects)).toHaveLength(0);
    expect(back.state.dialog?.field?.text).toBe('my reason');

    // Sent on fresh data, refused because the task moved: Esc and open again, as the dialog says.
    const sent = run(typed, key('tab'), ...chars('cancel'), key('enter'));
    const command = sentCommand(sent.effects);
    const refused = run(sent.state, {
      type: 'mutation_changed',
      mutation: {
        requestId: '019a0000-0000-7000-8000-0000000000dd',
        command,
        state: 'rejected',
        result: { ok: false, code: 'conflict', message: 'stale_version' },
        checks: 0,
        resends: 0,
      },
    }).state;
    expect(flat(text(refused))).toContain('Press Esc and open it again');
    const reopened = run(refused, key('esc'), key('enter'));
    expect(reopened.state.screens.at(-1)).toBe('dialog');
    expect(reopened.state.dialog?.field?.text).toBe('my reason');
    expect(reopened.state.dialog?.typed).toBe('');
    expect(submits(reopened.effects)).toHaveLength(0);
    // Memory only: the draft is not on any effect, so nothing writes it out.
    expect(JSON.stringify(reopened.effects)).not.toContain('my reason');

    // A write the daemon took drops the draft: the next dialog starts empty.
    const again = run(reopened.state, key('tab'), ...chars('cancel'), key('enter'));
    const accepted = run(again.state, {
      type: 'mutation_changed',
      mutation: {
        requestId: '019a0000-0000-7000-8000-0000000000de',
        command: sentCommand(again.effects),
        state: 'accepted',
        result: { ok: true, value: {} },
        checks: 0,
        resends: 0,
      },
    }).state;
    expect(accepted.drafts.size).toBe(0);
  });

  it('a failed Actions read locks the write until a read asked after it answers, keeping the text', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    const typed = run(open, ...chars('my reason')).state;
    const session = typed.actions?.session ?? 0;
    const explainRead = (ok: boolean, askedAt: number): Message => ({
      type: 'actions_read',
      taskId: TASK,
      session,
      askedAt,
      at: askedAt + 1,
      watermark: 7,
      result: ok
        ? { ok: true, value: explainOf({}, ['cancel']) }
        : {
            ok: false,
            error: { kind: 'rejected', code: 'internal', message: uiText('x') } as never,
          },
    });
    const failedRead = run(typed, explainRead(false, 30)).state;
    expect(failedRead.connection.kind).toBe('online');
    const tried = run(failedRead, key('tab'), ...chars('cancel'), key('enter'));
    expect(submits(tried.effects)).toHaveLength(0);
    expect(flat(text(tried.state))).toContain('could not be read just now');
    expect(tried.state.dialog?.field?.text).toBe('my reason');
    const sent = run(tried.state, explainRead(true, 40), key('enter'));
    expect(sentCommand(sent.effects).payload).toEqual({ reason: 'my reason' });
  });

  it('a draft whose write turned unknown comes back when the lookup finds it refused, and goes when taken', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    const sent = run(open, ...chars('my reason'), key('tab'), ...chars('cancel'), key('enter'));
    const command = sentCommand(sent.effects);
    const mutation = (state: 'unknown' | 'rejected' | 'accepted'): Message => ({
      type: 'mutation_changed',
      mutation: {
        requestId: '019a0000-0000-7000-8000-0000000000df',
        command,
        state,
        result:
          state === 'unknown'
            ? null
            : state === 'accepted'
              ? { ok: true, value: {} }
              : { ok: false, code: 'conflict', message: 'stale_version' },
        checks: 1,
        resends: 0,
      },
    });
    const lostAnswer = run(sent.state, mutation('unknown')).state;
    expect(lostAnswer.dialog).toBeNull();
    const refused = run(lostAnswer, mutation('rejected'));
    const reopened = run(refused.state, key('enter'));
    expect(reopened.state.dialog?.field?.text).toBe('my reason');
    expect(submits([...refused.effects, ...reopened.effects])).toHaveLength(0);

    const taken = run(run(sent.state, mutation('unknown')).state, mutation('accepted')).state;
    expect(taken.drafts.size).toBe(0);
  });

  it.each([
    ['taken at once', false],
    ['taken after an unknown result', true],
  ] as const)(
    'drops a draft that differs from the sent text only by what sending trims, %s',
    (_name, viaUnknown) => {
      const accepted = (state: TuiState, command: MutationCommand, path: boolean): TuiState => {
        const m = (st: 'unknown' | 'accepted'): Message => ({
          type: 'mutation_changed',
          mutation: {
            requestId: '019a0000-0000-7000-8000-0000000000e1',
            command,
            state: st,
            result: st === 'accepted' ? { ok: true, value: {} } : null,
            checks: 0,
            resends: 0,
          },
        });
        return path
          ? run(state, m('unknown'), m('accepted')).state
          : run(state, m('accepted')).state;
      };
      const cancel = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
      const sentCancel = run(
        cancel,
        ...chars('my reason  '),
        key('tab'),
        ...chars('cancel'),
        key('enter'),
      );
      expect(sentCommand(sentCancel.effects).payload).toEqual({ reason: 'my reason' });
      expect(
        accepted(sentCancel.state, sentCommand(sentCancel.effects), viaUnknown).drafts.size,
      ).toBe(0);

      const pause = run(menu(OWNER, explainOf({}, ['pause'])), key('enter')).state;
      const sentPause = run(pause, ...chars('  stop now '), key('ctrl_s'));
      expect(sentCommand(sentPause.effects).payload).toEqual({ reason: 'stop now' });
      expect(
        accepted(sentPause.state, sentCommand(sentPause.effects), viaUnknown).drafts.size,
      ).toBe(0);
    },
  );

  it('keeps a draft edited after its write went out when that write is taken', () => {
    const open = run(menu(OWNER, explainOf({}, ['cancel'])), key('enter')).state;
    const sent = run(open, ...chars('first'), key('tab'), ...chars('cancel'), key('enter'));
    const command = sentCommand(sent.effects);
    const change = (st: 'unknown' | 'accepted'): Message => ({
      type: 'mutation_changed',
      mutation: {
        requestId: '019a0000-0000-7000-8000-0000000000e2',
        command,
        state: st,
        result: st === 'accepted' ? { ok: true, value: {} } : null,
        checks: 0,
        resends: 0,
      },
    });
    const closed = run(sent.state, change('unknown')).state;
    // The write is still unknown: reopened, the reason is edited into a new draft and closed again.
    const edited = run(closed, key('enter'), ...chars(' and more'), key('esc')).state;
    expect([...edited.drafts.values()]).toEqual(['first and more']);
    expect([...run(edited, change('accepted')).state.drafts.values()]).toEqual(['first and more']);
  });

  it('an Answer draft belongs to its question, not to the next question on the task', () => {
    const OTHER_Q = '019a0000-0000-7000-8000-0000000000ab';
    const asking = (s: TuiState, id: string): Message => {
      const m = structuredClone(inboxMessage(s)) as Extract<Message, { type: 'dialog_read' }>;
      (m.result as { value: { items: { question_id: string }[] } }).value.items[0]!.question_id =
        id;
      return m;
    };
    const base = menu(OWNER, explainOf());
    const first = run(base, key('enter')).state;
    const typed = run(first, asking(first, QUESTION), ...chars('Use Postgres')).state;
    const closed = run(typed, key('esc')).state;

    const second = run(closed, key('enter')).state;
    const onB = run(second, asking(second, OTHER_Q)).state;
    expect(onB.dialog?.known?.id).toBe(OTHER_Q);
    expect(onB.dialog?.field?.text).toBe('');

    const third = run(run(onB, key('esc')).state, key('enter')).state;
    const onA = run(third, asking(third, QUESTION)).state;
    expect(onA.dialog?.field?.text).toBe('Use Postgres');
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
