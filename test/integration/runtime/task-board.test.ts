import { afterEach, describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { ATTENTION_LIMIT, statusSinceReader, taskBoard } from '../../../src/application/board.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { buildTask, ownerAuthz, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createGrantStart, selectionFor } from '../../support/runtime.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-board-');

const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};
type Row = {
  task_id: string;
  project: string;
  title: string;
  status: string;
  wait_code: string | null;
  step: string | null;
  mode: string | null;
  status_since: number | null;
  version: number;
  priority: number;
  pr_ref: string | null;
  needs_user: boolean;
  step_visits: Record<string, number>;
};
type Board = {
  unchanged: boolean;
  watermark: number;
  counts?: { by_status: Record<string, number> };
  queue?: { length: number };
  attention?: { items: Row[]; truncated: boolean };
  items?: Row[];
  next_cursor?: string | null;
};

function setup() {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const since = statusSinceReader(d.store);
  const board = (body: Record<string, unknown> = {}, caller: Caller = OWNER): Board => {
    const r = taskBoard({ store: d.store, statusSince: since }, caller, {
      kind: 'task_board',
      ...body,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value as Board;
  };
  return { d, board };
}

let next = 100;
function add(d: StoreDriver, over: Partial<CanonicalTask> = {}): CanonicalTask {
  const t = buildTask({ id: uuidOf(next++), ...over });
  d.must(t.id, { kind: 'create_task', task: t });
  return t;
}
function cancelled(d: StoreDriver, over: Partial<CanonicalTask> = {}) {
  const t = add(d, over);
  d.must(t.id, { kind: 'cancel', reason: 'stop' });
  return t;
}

describe('task_board', () => {
  it('returns rows with what a list needs, in task ID order', () => {
    const { d, board } = setup();
    const a = add(d, { title: 'First', priority: 5 });
    const b = add(d, { title: 'Second' });
    const r = board();
    expect(r.unchanged).toBe(false);
    expect(r.items?.map((i) => i.task_id)).toEqual([a.id, b.id]);
    expect(r.items?.[0]).toEqual({
      task_id: a.id,
      project: 'acme',
      title: 'First',
      status: expect.any(String) as string,
      wait_code: null,
      step: null,
      mode: null,
      status_since: d.now,
      version: d.task(a.id).version,
      priority: 5,
      pr_ref: null,
      step_visits: {},
      needs_user: true,
    });
    expect(r.next_cursor).toBeNull();
  });

  it('answers unchanged when nothing new happened, and only then', () => {
    const { d, board } = setup();
    const a = add(d);
    const first = board();
    expect(board({ if_changed_since: first.watermark })).toEqual({
      unchanged: true,
      watermark: first.watermark,
    });
    d.must(a.id, { kind: 'cancel', reason: 'stop' });
    const changed = board({ if_changed_since: first.watermark });
    expect(changed.unchanged).toBe(false);
    expect(changed.watermark).toBeGreaterThan(first.watermark);
  });

  it('an empty store has a watermark of zero', () => {
    const { board } = setup();
    expect(board()).toMatchObject({
      unchanged: false,
      watermark: 0,
      items: [],
      counts: { by_status: {} },
    });
  });

  it('defaults to active tasks; counts cover every status and do not follow the scope', () => {
    const { d, board } = setup();
    const active = add(d);
    const done = cancelled(d);
    const r = board();
    expect(r.items?.map((i) => i.task_id)).toEqual([active.id]);
    expect(r.counts?.by_status).toEqual({ READY: 1, CANCELLED: 1 });
    expect(board({ scope: 'terminal' }).items?.map((i) => i.task_id)).toEqual([done.id]);
    expect(board({ scope: 'all' }).items?.map((i) => i.task_id)).toEqual([active.id, done.id]);
  });

  it('a status filter without a scope reaches every status', () => {
    const { d, board } = setup();
    add(d);
    const done = cancelled(d);
    const r = board({ status: 'CANCELLED' });
    expect(r.items?.map((i) => i.task_id)).toEqual([done.id]);
    expect(r.counts?.by_status).toEqual({ CANCELLED: 1 });
  });

  it('pages with a limit of at most 100, counts not following the page (EC-005)', () => {
    const { d, board } = setup();
    const ids = Array.from({ length: 105 }, () => add(d).id);
    const first = board();
    expect(first.items).toHaveLength(100);
    expect(first.next_cursor).toBe(ids[99]);
    expect(first.counts?.by_status).toEqual({ READY: 105 });
    const second = board({ cursor: first.next_cursor });
    expect(second.items?.map((i) => i.task_id)).toEqual(ids.slice(100));
    expect(second.next_cursor).toBeNull();
    expect(second.counts?.by_status).toEqual({ READY: 105 });
    expect(board({ limit: 2 }).items).toHaveLength(2);
  });

  it('lists the newest task first on request, the cursor moving toward older tasks', () => {
    const { d, board } = setup();
    const newest = Array.from({ length: 105 }, () => add(d).id).reverse();
    const first = board({ order: 'newest' });
    expect(first.items?.map((i) => i.task_id)).toEqual(newest.slice(0, 100));
    expect(first.next_cursor).toBe(newest[99]);
    const second = board({ order: 'newest', cursor: first.next_cursor });
    expect(second.items?.map((i) => i.task_id)).toEqual(newest.slice(100));
    expect(second.next_cursor).toBeNull();
    const r = taskBoard({ store: d.store, statusSince: statusSinceReader(d.store) }, OWNER, {
      kind: 'task_board',
      limit: 101,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('the project filter applies to rows, counts and attention', () => {
    const { d, board } = setup();
    const a = add(d);
    const o = add(d, { project: 'other' });
    const r = board({ project: 'other' });
    expect(r.items?.map((i) => i.task_id)).toEqual([o.id]);
    expect(r.counts?.by_status).toEqual({ READY: 1 });
    expect(r.attention?.items.map((i) => i.task_id)).toEqual([o.id]);
    expect(board().attention?.items.map((i) => i.task_id)).toEqual([a.id, o.id]);
  });

  it('attention holds only tasks that need the user, up to its limit', () => {
    const { d, board } = setup();
    const t = buildTask({ id: uuidOf(next++) });
    createGrantStart(d, t, 'direct-pr');
    const needing = add(d);
    const r = board();
    expect(r.attention?.items.map((i) => i.task_id)).toEqual([needing.id]);
    expect(r.attention?.truncated).toBe(false);
    expect(r.items?.find((i) => i.task_id === t.id)).toMatchObject({
      needs_user: false,
      status: 'RUNNING',
      mode: 'direct-pr',
      step: expect.any(String) as string,
    });
  });

  it('newest first also orders attention, so the cap keeps the newest', () => {
    const { d, board } = setup();
    const ids = Array.from({ length: ATTENTION_LIMIT + 1 }, () => add(d).id);
    const r = board({ order: 'newest', limit: 1 });
    expect(r.attention?.items[0]?.task_id).toBe(ids.at(-1));
    expect(r.attention?.items.map((i) => i.task_id)).not.toContain(ids[0]);
    expect(r.attention?.truncated).toBe(true);
  });

  it('attention is capped and says so', () => {
    const { d, board } = setup();
    for (let i = 0; i < ATTENTION_LIMIT + 1; i++) add(d);
    const r = board({ limit: 1 });
    expect(r.attention?.items).toHaveLength(ATTENTION_LIMIT);
    expect(r.attention?.truncated).toBe(true);
    expect(r.items).toHaveLength(1);
  });

  it('counts the queue', () => {
    const { d, board } = setup();
    const t = add(d);
    const sel = selectionFor(t, 'direct-pr');
    d.must(t.id, { kind: 'propose_run_config', selection: sel }, { authz: ownerAuthz() });
    d.must(t.id, { kind: 'request_execution' });
    expect(board().queue?.length).toBe(1);
  });

  it('does not read the state of finished tasks outside the page', () => {
    const { d } = setup();
    for (let i = 0; i < 3; i++) cancelled(d);
    const active = add(d);
    const read: string[] = [];
    const store = new Proxy(d.store, {
      get(target, prop, receiver) {
        if (prop === 'readTask')
          return (id: string) => {
            read.push(id);
            return target.readTask(id as never);
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const r = taskBoard({ store, statusSince: statusSinceReader(store) }, OWNER, {
      kind: 'task_board',
    });
    expect(r.ok).toBe(true);
    expect([...new Set(read)]).toEqual([active.id]);
  });

  it('changes nothing', () => {
    const { d, board } = setup();
    add(d);
    const db = storeDb(d.store);
    const n = () => (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    const before = n();
    board();
    board({ scope: 'all' });
    expect(n()).toBe(before);
  });

  it('rejects unknown fields', () => {
    const { d } = setup();
    const r = taskBoard({ store: d.store, statusSince: statusSinceReader(d.store) }, OWNER, {
      kind: 'task_board',
      extra: 1,
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

describe('status_since (R-06)', () => {
  it('is the time of the trigger that last changed the status, not of later events', () => {
    const { d, board } = setup();
    const t = add(d, { requested_by: { kind: 'assistant', id: 'assistant' } });
    const created = d.now;
    expect(d.task(t.id).status).toBe('PENDING');
    d.now += 1_000;
    d.must(t.id, { kind: 'confirm_task' });
    const statusAfterConfirm = d.task(t.id).status;
    expect(statusAfterConfirm).toBe('READY');
    const confirmedAt = d.now;
    expect(confirmedAt).toBeGreaterThan(created);
    d.now += 1_000;
    const sel = selectionFor(t, 'direct-pr');
    d.must(t.id, { kind: 'propose_run_config', selection: sel }, { authz: ownerAuthz() });
    expect(d.task(t.id).status).toBe(statusAfterConfirm);
    expect(board().items?.[0]?.status_since).toBe(confirmedAt);
  });

  it('remembers by task and version, and follows a new status', () => {
    const { d, board } = setup();
    const t = add(d);
    const first = board().items?.[0]?.status_since;
    expect(board().items?.[0]?.status_since).toBe(first);
    d.now += 5_000;
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    expect(board({ scope: 'all' }).items?.[0]?.status_since).toBe(d.now);
  });

  it('is null for an old log whose trigger has no time', () => {
    const { d, board } = setup();
    add(d);
    storeDb(d.store)
      .prepare(`UPDATE accepted_triggers SET envelope_json = json_remove(envelope_json, '$.now')`)
      .run();
    expect(board().items?.[0]?.status_since).toBeNull();
  });

  it('is null when the event names no trigger', () => {
    const { d, board } = setup();
    add(d);
    storeDb(d.store).prepare('UPDATE events SET dedup_key = NULL').run();
    expect(board().items?.[0]?.status_since).toBeNull();
  });

  it('survives a daemon restart', async () => {
    const sd = new SeededDaemon();
    try {
      const t = buildTask({ id: uuidOf(next++) });
      const at = sd.seed((d) => {
        d.must(t.id, { kind: 'create_task', task: t });
        return d.now;
      });
      sd.now += 60_000;
      await sd.start();
      const read = async () =>
        (await sd.query('owner', { kind: 'task_board' })).envelope.data as Board;
      expect((await read()).items?.[0]?.status_since).toBe(at);
      await sd.stop();
      await sd.start();
      expect((await read()).items?.[0]?.status_since).toBe(at);
    } finally {
      await sd.cleanup();
    }
  });
});

afterEach(() => {
  next = 100;
});
