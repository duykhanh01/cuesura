import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTENTION_STALE_MS,
  AttentionDesk,
  registeredSession,
  replacedSessions,
} from '../../../src/application/attention.ts';
import { readSessionFile } from '../../../src/application/assistant-session.ts';
import type { Caller } from '../../../src/application/authz.ts';
import { callerFor } from '../../../src/application/authz.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { EFFECT_UNKNOWN_ATTENTION_MS } from '../../../src/explain/needs-user.ts';
import type { Store } from '../../../src/store/index.ts';

const CALLER = callerFor('assistant') as Caller;

const waiting = (id: string, code: string): TaskState =>
  ({
    id,
    project: 'p',
    task: { title: id },
    status: 'WAITING',
    revision: 1,
    version: 7,
    questions: {},
    wait: { reason: 'policy', detail: { code } },
  }) as unknown as TaskState;

function bench(tasks: TaskState[] = []) {
  const state = {
    tasks,
    seq: 1,
    entered: 1,
    now: 0,
    reads: 0,
    ended: [] as { task_id: string; global_seq: number; kind: 'DONE' | 'FAILED' | 'CANCELLED' }[],
  };
  const store = {
    lastGlobalSeq: () => state.seq,
    terminalEventsAfter: (after: number) => state.ended.filter((e) => e.global_seq > after),
    readEvents: () => [{ type: 'TaskWaiting', global_seq: state.entered }],
    taskIdsByStatus: () => state.tasks.map((t) => t.id),
    readTask: (id: string) => {
      state.reads += 1;
      return state.tasks.find((t) => t.id === id) ?? null;
    },
  } as unknown as Store;
  const desk = () => new AttentionDesk({ store, now: () => state.now });
  return { state, desk, store };
}

const NEW = { lease: 'session-a', mode: 'attach' };
const OTHER = { lease: 'session-b', mode: 'attach' };
const back = (lease: string) => ({ lease, mode: 'resume' });

const value = <T>(r: { ok: true; value: T } | { ok: false }): T => {
  if (!r.ok) throw new Error('expected ok');
  return r.value;
};
const code = (r: { ok: true } | { ok: false; error: { code: string } }): string =>
  r.ok ? 'ok' : r.error.code;

const ended = (id: string, status: string): TaskState =>
  ({ ...waiting(id, 'merge'), status, wait: null }) as unknown as TaskState;

describe('AttentionDesk', () => {
  it('wakes the holder once for each task that ends after it took the lease (#257)', () => {
    const { state, desk } = bench([ended('old', 'DONE')]);
    state.ended.push({ task_id: 'old', global_seq: 1, kind: 'DONE' });
    const d = desk();
    const first = value(d.poll(CALLER, NEW));
    expect(first.items).toEqual([]);
    state.tasks.push(ended('a', 'DONE'), ended('b', 'FAILED'), ended('c', 'CANCELLED'));
    state.ended.push(
      { task_id: 'a', global_seq: 2, kind: 'DONE' },
      { task_id: 'b', global_seq: 3, kind: 'FAILED' },
      { task_id: 'c', global_seq: 4, kind: 'CANCELLED' },
    );
    state.seq = 4;
    const told = value(d.poll(CALLER, back(first.lease)));
    expect(told.items.map((i) => [i.task_id, i.code])).toEqual([
      ['a', 'done'],
      ['b', 'failed'],
      ['c', 'cancelled'],
    ]);
    // Unconfirmed: a retry of the lost reply carries them again.
    const retry = value(d.poll(CALLER, back(first.lease)));
    expect(retry.items).toEqual(told.items);
    const confirmed = value(d.poll(CALLER, back(retry.lease)));
    expect(confirmed.items).toEqual([]);
    state.seq = 5;
    expect(value(d.poll(CALLER, back(confirmed.lease))).items).toEqual([]);
  });

  it('tells each wait once and reads no task while the log is unchanged', () => {
    const { state, desk } = bench([waiting('a', 'merge')]);
    const d = desk();
    const first = value(d.poll(CALLER, NEW));
    expect(first.items.map((i) => i.task_id)).toEqual(['a']);
    const quiet = value(d.poll(CALLER, back(first.lease)));
    expect(quiet.items).toEqual([]);
    state.reads = 0;
    expect(value(d.poll(CALLER, back(quiet.lease))).items).toEqual([]);
    expect(state.reads).toBe(0);
    state.seq = 2;
    expect(value(d.poll(CALLER, back(first.lease))).items).toEqual([]);
  });

  it('sends again what a lost reply carried, until the holder confirms it', () => {
    const { desk } = bench([waiting('a', 'merge')]);
    const d = desk();
    const lost = value(d.poll(CALLER, NEW));
    const retry = value(d.poll(CALLER, NEW));
    expect(retry.items).toEqual(lost.items);
    const again = value(d.poll(CALLER, back('session-a.0')));
    expect(again.items).toEqual(lost.items);
    expect(value(d.poll(CALLER, back(again.lease))).items).toEqual([]);
  });

  it('confirms the batch a restart interrupted only with a later reply', () => {
    const { state, desk } = bench([waiting('a', 'merge')]);
    const old = desk();
    old.poll(CALLER, NEW);
    const { lease } = value(old.poll(CALLER, back('session-a.0')));
    const after = desk();
    const told = value(after.poll(CALLER, back(lease)));
    expect(told.items).toHaveLength(1);
    state.tasks.push(waiting('b', 'merge'));
    state.seq = 2;
    expect(value(after.poll(CALLER, back(lease))).items).toHaveLength(2);
  });

  it('tells a new entry into a wait identical to the last one', () => {
    const { state, desk } = bench([waiting('a', 'harness_auth')]);
    const d = desk();
    const { lease } = value(d.poll(CALLER, NEW));
    state.tasks = [{ ...waiting('a', 'harness_auth'), version: 8 }];
    state.entered = 2;
    state.seq = 2;
    expect(value(d.poll(CALLER, back(lease))).items).toHaveLength(1);
  });

  it('leaves out a wait that resolves without a person', () => {
    const { desk } = bench([waiting('a', 'rate_limited')]);
    expect(value(desk().poll(CALLER, NEW)).items).toEqual([]);
  });

  it('tells again a wait that ended and came back', () => {
    const { state, desk } = bench([waiting('a', 'merge')]);
    const d = desk();
    const { lease } = value(d.poll(CALLER, NEW));
    state.tasks = [];
    state.seq = 2;
    d.poll(CALLER, back(lease));
    state.tasks = [waiting('a', 'merge')];
    state.seq = 3;
    expect(value(d.poll(CALLER, back(lease))).items).toHaveLength(1);
  });

  it('lets a new session in once the holder stops polling, and stops the old one', () => {
    const { state, desk } = bench();
    const d = desk();
    const { lease } = value(d.poll(CALLER, NEW));
    state.now = ATTENTION_STALE_MS - 1;
    expect(code(d.poll(CALLER, OTHER))).toBe('attention_held');
    state.now = 2 * ATTENTION_STALE_MS;
    const next = value(d.poll(CALLER, OTHER));
    expect(next.lease).not.toBe(lease);
    expect(code(d.poll(CALLER, back(lease)))).toBe('attention_superseded');
  });

  it('resumes a lease after a daemon restart and tells what still waits', () => {
    const { desk } = bench([waiting('a', 'merge')]);
    const { lease } = value(desk().poll(CALLER, NEW));
    const after = value(desk().poll(CALLER, back(lease)));
    expect(after.lease.split('.')[0]).toBe(lease.split('.')[0]);
    expect(after.items).toHaveLength(1);
  });

  it('leaves out what the decider holds and tells it once the decider gives it up', () => {
    const { store } = bench([waiting('a', 'agent_question'), waiting('b', 'merge')]);
    const held = new Set(['a']);
    let version = 0;
    const d = new AttentionDesk({
      store,
      now: () => 0,
      decider: { holds: (s) => held.has(s.id), version: () => version },
    });
    const first = value(d.poll(CALLER, NEW));
    expect(first.items.map((i) => i.task_id)).toEqual(['b']);
    const quiet = value(d.poll(CALLER, back(first.lease)));
    expect(quiet.items).toEqual([]);
    held.delete('a');
    version += 1;
    expect(value(d.poll(CALLER, back(quiet.lease))).items.map((i) => i.task_id)).toEqual(['a']);
  });

  it('holds back what is over the limit for the next poll', () => {
    const many = Array.from({ length: 101 }, (_, i) => waiting(`t${i}`, 'merge'));
    const { desk } = bench(many);
    const d = desk();
    const first = value(d.poll(CALLER, NEW));
    expect(first).toMatchObject({ truncated: true });
    expect(first.items).toHaveLength(100);
    expect(value(d.poll(CALLER, back(first.lease))).items).toHaveLength(1);
  });
});

describe('registered assistant session', () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'attention-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const hook = (lease: string) => ({ lease, mode: 'hook' });
  const SESSION = { session: 's-1' };

  it('refuses a hook of any session that is not registered', () => {
    const { store, state } = bench([waiting('a', 'merge')]);
    const d = new AttentionDesk({ store, now: () => state.now, dataDir: dir() });
    expect(code(d.poll(CALLER, hook('s-1')))).toBe('attention_not_registered');
    expect(code(d.register(CALLER, SESSION))).toBe('ok');
    expect(code(d.poll(CALLER, hook('s-2')))).toBe('attention_not_registered');
    expect(value(d.poll(CALLER, hook('s-1'))).items).toHaveLength(1);
  });

  it('tells a task that ended before a restart and was not confirmed, also to a new lease (#257)', () => {
    const { store, state } = bench();
    const dataDir = dir();
    const first = new AttentionDesk({ store, now: () => state.now, dataDir });
    const { lease } = value(first.poll(CALLER, NEW));
    state.tasks.push(ended('a', 'DONE'));
    state.ended.push({ task_id: 'a', global_seq: 2, kind: 'DONE' });
    state.seq = 2;
    // Sent, then the daemon restarts before the holder confirms it.
    expect(value(first.poll(CALLER, back(lease))).items).toHaveLength(1);
    state.seq = 3;

    const resumed = new AttentionDesk({ store, now: () => state.now, dataDir });
    const again = value(resumed.poll(CALLER, back(lease)));
    expect(again.items.map((i) => [i.task_id, i.code])).toEqual([['a', 'done']]);
    expect(value(resumed.poll(CALLER, back(again.lease))).items).toEqual([]);

    // Unconfirmed when the lease moves: the next holder is told.
    const moved = new AttentionDesk({ store, now: () => state.now, dataDir });
    state.tasks.push(ended('b', 'FAILED'));
    state.ended.push({ task_id: 'b', global_seq: 4, kind: 'FAILED' });
    state.seq = 4;
    expect(value(moved.poll(CALLER, back(again.lease))).items).toHaveLength(1);
    state.now = 2 * ATTENTION_STALE_MS;
    const other = value(moved.poll(CALLER, OTHER));
    expect(other.items.map((i) => i.task_id)).toEqual(['b']);
  });

  it('keeps the registration and tells again what waits after a restart', () => {
    const { store, state } = bench([waiting('a', 'merge')]);
    const dataDir = dir();
    const first = new AttentionDesk({ store, now: () => state.now, dataDir });
    first.register(CALLER, SESSION);
    const told = value(first.poll(CALLER, hook('s-1')));
    expect(told.items).toHaveLength(1);

    const after = new AttentionDesk({ store, now: () => state.now, dataDir });
    expect(value(after.poll(CALLER, hook(told.lease))).items).toHaveLength(1);
    expect(code(after.poll(CALLER, NEW))).toBe('attention_held');
  });

  it('a reply lost right after a restart is not taken for one that arrived', () => {
    const { store, state } = bench([waiting('a', 'merge')]);
    const dataDir = dir();
    const first = new AttentionDesk({ store, now: () => state.now, dataDir });
    first.register(CALLER, SESSION);
    const told = value(first.poll(CALLER, hook('s-1')));
    state.tasks = [];
    state.seq = 2;
    value(first.poll(CALLER, hook(told.lease)));

    const after = new AttentionDesk({ store, now: () => state.now, dataDir });
    state.tasks = [waiting('b', 'merge')];
    state.seq = 3;
    const lost = value(after.poll(CALLER, hook(told.lease)));
    expect(lost.items).toHaveLength(1);
    expect(lost.lease).not.toBe(told.lease);
    expect(value(after.poll(CALLER, hook(told.lease))).items).toHaveLength(1);
  });

  it('does not repeat a wake the hook confirmed by coming back', () => {
    const { store, state } = bench([waiting('a', 'merge')]);
    const d = new AttentionDesk({ store, now: () => state.now, dataDir: dir() });
    d.register(CALLER, SESSION);
    const told = value(d.poll(CALLER, hook('s-1')));
    state.seq = 2;
    expect(value(d.poll(CALLER, hook(told.lease))).items).toEqual([]);
  });

  it('holds the lease against another session and gives way to take', () => {
    const { store, state } = bench();
    const dataDir = dir();
    const d = new AttentionDesk({ store, now: () => state.now, dataDir });
    d.register(CALLER, SESSION);
    expect(code(d.register(CALLER, { session: 's-2' }))).toBe('attention_held');
    expect(code(d.register(CALLER, { session: 's-2', take: true }))).toBe('ok');
    expect(code(d.poll(CALLER, hook('s-1')))).toBe('attention_superseded');
    expect(registeredSession(dataDir)).toBe('s-2');
  });

  it('forgets the registration when a wait takes the lease', () => {
    const { store, state } = bench();
    const dataDir = dir();
    const d = new AttentionDesk({ store, now: () => state.now, dataDir });
    d.register(CALLER, SESSION);
    d.poll(CALLER, { lease: 'session-a', mode: 'take' });
    expect(registeredSession(dataDir)).toBeNull();
  });

  it('peek counts what waits without taking the lease or using up a delivery', () => {
    const { store, state } = bench([waiting('a', 'merge')]);
    const d = new AttentionDesk({ store, now: () => state.now, dataDir: dir() });
    expect(value(d.peek(CALLER)).waiting).toBe(1);
    expect(code(d.register(CALLER, SESSION))).toBe('ok');
    expect(value(d.poll(CALLER, hook('s-1'))).items).toHaveLength(1);
  });

  it('unregister stops the hook and frees the lease', () => {
    const { store, state } = bench();
    const dataDir = dir();
    const d = new AttentionDesk({ store, now: () => state.now, dataDir });
    d.register(CALLER, SESSION);
    expect(value(d.unregister(CALLER, {})).session).toBe('s-1');
    expect(registeredSession(dataDir)).toBeNull();
    expect(code(d.poll(CALLER, hook('s-1')))).toBe('attention_not_registered');
    expect(code(d.poll(CALLER, NEW))).toBe('ok');
  });

  it('unregister drops the ended-task mark once nobody holds the lease (#257)', () => {
    const { store, state } = bench();
    const dataDir = dir();
    const waiter = new AttentionDesk({ store, now: () => state.now, dataDir });
    waiter.poll(CALLER, NEW);
    expect(readSessionFile(dataDir).ended_after).toBe(1);
    // A session still waiting keeps it.
    expect(code(waiter.unregister(CALLER, {}))).toBe('ok');
    expect(readSessionFile(dataDir).ended_after).toBe(1);
    const restarted = new AttentionDesk({ store, now: () => state.now, dataDir });
    expect(code(restarted.unregister(CALLER, {}))).toBe('ok');
    expect(readSessionFile(dataDir).ended_after).toBeNull();
  });
});

describe('AttentionDesk and a long effect_unknown (#249)', () => {
  const unknownWait = (id: string): TaskState =>
    ({
      ...waiting(id, 'effect_unknown'),
      wait: { reason: 'infra', detail: { code: 'effect_unknown', since: 0 } },
    }) as unknown as TaskState;

  it('tells the wait once it is overdue, though the log did not change, and reads nothing before that', () => {
    const { state, desk } = bench([unknownWait('a')]);
    const d = desk();
    const first = value(d.poll(CALLER, NEW));
    expect(first.items).toEqual([]);
    const reads = state.reads;
    state.now = EFFECT_UNKNOWN_ATTENTION_MS - 1;
    expect(value(d.poll(CALLER, back(first.lease))).items).toEqual([]);
    expect(state.reads).toBe(reads);

    state.now = EFFECT_UNKNOWN_ATTENTION_MS;
    const due = value(d.poll(CALLER, back(first.lease)));
    expect(due.items.map((i) => i.task_id)).toEqual(['a']);
    // Told once: confirming the batch sends nothing more, and nothing is due any more.
    expect(value(d.poll(CALLER, back(due.lease))).items).toEqual([]);
    const after = state.reads;
    expect(value(d.poll(CALLER, back(due.lease))).items).toEqual([]);
    expect(state.reads).toBe(after);
  });
});

describe('waking the assistant (#268)', () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'attention-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const hook = (lease: string) => ({ lease, mode: 'hook' });
  const registered = () => {
    const b = bench([waiting('a', 'merge')]);
    const dataDir = dir();
    const d = new AttentionDesk({ store: b.store, now: () => b.state.now, dataDir });
    return { ...b, d, dataDir };
  };

  it('a live holder that was sent everything makes peek say nothing is left to tell', () => {
    const { state, desk } = bench([waiting('a', 'merge')]);
    const d = desk();
    expect(value(d.peek(CALLER))).toEqual({
      waiting: 1,
      held: false,
      undelivered: 1,
      tasks: [{ task_id: 'a', code: 'merge', undelivered: true }],
    });
    const { lease } = value(d.poll(CALLER, NEW));
    expect(value(d.peek(CALLER))).toEqual({
      waiting: 1,
      held: true,
      undelivered: 0,
      tasks: [{ task_id: 'a', code: 'merge', undelivered: false }],
    });
    value(d.poll(CALLER, back(lease)));
    expect(value(d.peek(CALLER))).toMatchObject({ held: true, undelivered: 0 });
    state.tasks.push(waiting('b', 'merge'));
    state.seq = 2;
    expect(value(d.peek(CALLER))).toMatchObject({ waiting: 2, undelivered: 1 });
  });

  it('a holder that stopped polling no longer holds, registered or not', () => {
    const { state, desk } = bench([waiting('a', 'merge')]);
    const d = desk();
    value(d.poll(CALLER, NEW));
    state.now = ATTENTION_STALE_MS;
    expect(value(d.peek(CALLER)).held).toBe(false);

    const r = registered();
    r.d.register(CALLER, { session: 's-1' });
    expect(value(r.d.peek(CALLER))).toMatchObject({ held: true, undelivered: 0 });
    // Told everything, then died: a session opening must still be asked (#244 keeps it a user decision).
    r.state.now = ATTENTION_STALE_MS;
    expect(value(r.d.peek(CALLER))).toMatchObject({ waiting: 1, held: false, undelivered: 0 });
  });

  it('keeps the replaced session on disk, so its next Stop can be told without a hook parked', () => {
    const { d, state, dataDir } = registered();
    d.register(CALLER, { session: 's-1' });
    d.register(CALLER, { session: 's-2', take: true });
    expect(replacedSessions(dataDir)).toEqual(['s-1']);
    expect(registeredSession(dataDir)).toBe('s-2');
    expect(code(d.movedAck(CALLER, { session: 's-1' }))).toBe('ok');
    expect(replacedSessions(dataDir)).toEqual([]);
    expect(registeredSession(dataDir)).toBe('s-2');

    state.now = 2 * ATTENTION_STALE_MS;
    value(d.poll(CALLER, NEW));
    expect(replacedSessions(dataDir)).toEqual(['s-2']);
    expect(registeredSession(dataDir)).toBeNull();
    expect(code(d.poll(CALLER, hook('s-2')))).toBe('attention_superseded');
  });

  it('remembers every replaced session until each says it was told', () => {
    const { d, dataDir } = registered();
    d.register(CALLER, { session: 'A' });
    d.register(CALLER, { session: 'B', take: true });
    d.register(CALLER, { session: 'C', take: true });
    expect(replacedSessions(dataDir)).toEqual(['A', 'B']);
    expect(code(d.poll(CALLER, hook('A')))).toBe('attention_superseded');
    d.movedAck(CALLER, { session: 'B' });
    expect(replacedSessions(dataDir)).toEqual(['A']);
    expect(registeredSession(dataDir)).toBe('C');
  });

  it('keeps that across a daemon restart, and drops a session that registers again', () => {
    const { store, state } = bench();
    const dataDir = dir();
    const d = new AttentionDesk({ store, now: () => state.now, dataDir });
    d.register(CALLER, { session: 'A' });
    d.register(CALLER, { session: 'B', take: true });
    const after = new AttentionDesk({ store, now: () => state.now, dataDir });
    expect(code(after.poll(CALLER, hook('A')))).toBe('attention_superseded');
    after.register(CALLER, { session: 'A', take: true });
    expect(replacedSessions(dataDir)).toEqual(['B']);
  });

  it('register lists what waits, and the hook coming back with that lease is not sent it again', () => {
    const { d } = registered();
    const reg = value(d.register(CALLER, { session: 's-1' }));
    expect(reg.items.map((i) => i.task_id)).toEqual(['a']);
    expect(reg.lease).toBe('s-1.1');
    expect(value(d.poll(CALLER, hook(reg.lease))).items).toEqual([]);
  });

  it('register --take lists what waits too', () => {
    const { d } = registered();
    d.register(CALLER, { session: 's-1' });
    const taken = value(d.register(CALLER, { session: 's-2', take: true }));
    expect(taken.items).toHaveLength(1);
    expect(value(d.poll(CALLER, hook(taken.lease))).items).toEqual([]);
  });

  it('the hook of a registered session a wait took the lease from learns it moved', () => {
    const { d, state, dataDir } = registered();
    d.register(CALLER, { session: 's-1' });
    state.now = 2 * ATTENTION_STALE_MS;
    expect(code(d.poll(CALLER, NEW))).toBe('ok');
    expect(registeredSession(dataDir)).toBeNull();
    expect(code(d.poll(CALLER, hook('s-1')))).toBe('attention_superseded');
  });

  it('attention_held says when to retry and that a session that lost its own lease only waits (#258)', () => {
    const { state, desk } = bench();
    const d = desk();
    value(d.poll(CALLER, NEW));
    state.now = 3_000;
    const r = d.poll(CALLER, OTHER);
    if (r.ok) throw new Error('expected attention_held');
    expect(r.error.details).toMatchObject({ retry_after_ms: ATTENTION_STALE_MS - 3_000 });
    expect(r.error.details['guidance']).toContain('without --take');
  });

  it('a malformed --lease says how to get one (#260)', () => {
    const r = bench().desk().poll(CALLER, { lease: 'a.b.c', mode: 'resume' });
    if (r.ok) throw new Error('expected invalid_request');
    expect(r.error.code).toBe('invalid_request');
    expect(r.error.details['guidance']).toContain('cusr assistant wait');
  });

  it('claiming the lease needs operate; following it needs read', () => {
    const reader = { grant: { actor: 'reader', roles: ['read' as const] } };
    const d = bench().desk();
    expect(code(d.poll(reader, NEW))).toBe('forbidden');
    expect(code(d.poll(reader, { lease: 'session-a', mode: 'take' }))).toBe('forbidden');
    value(d.poll(CALLER, NEW));
    expect(code(d.poll(reader, back('session-a.0')))).toBe('ok');
  });

  it('unregister from another session leaves the registration alone', () => {
    const { d, dataDir } = registered();
    d.register(CALLER, { session: 's-1' });
    expect(code(d.unregister(CALLER, { session: 's-2' }))).toBe('attention_not_registered');
    expect(registeredSession(dataDir)).toBe('s-1');
    expect(value(d.unregister(CALLER, { session: 's-1' })).session).toBe('s-1');
  });
});
