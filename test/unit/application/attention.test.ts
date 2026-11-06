import { describe, expect, it } from 'vitest';
import { ATTENTION_STALE_MS, AttentionDesk } from '../../../src/application/attention.ts';
import type { Caller } from '../../../src/application/authz.ts';
import { callerFor } from '../../../src/application/authz.ts';
import type { TaskState } from '../../../src/domain/state.ts';
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
  const state = { tasks, seq: 1, entered: 1, now: 0, reads: 0 };
  const store = {
    lastGlobalSeq: () => state.seq,
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

describe('AttentionDesk', () => {
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
