import { describe, expect, it } from 'vitest';
import { startTask, type StartResult } from '../../../src/application/start.ts';
import { Scheduler } from '../../../src/daemon/scheduler.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { explainRuntime } from '../../../src/explain/explain.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { authz, buildTask, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import {
  configuredSelection,
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';
import { createGrantStart, proposeAndConfirm } from '../../support/runtime.ts';
import { agentData, ciData, PREPARE_DATA, publishData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { reviewToCi, toPublish } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// Reservations and loans of the execution slot while a task waits outside (issue #206, FR-044.02/04/06/07).

const tempDir = useTempDir('cusr-slot-reservation-');
// Below the one-hour task deadline createGrantStart freezes.
const TTL = 20 * 60 * 1000;

function setup(opts: { concurrency?: number; reservationMs?: number; path?: string } = {}) {
  const path = opts.path ?? dbPath(tempDir());
  const d = new StoreDriver(openFileStoreForTest(path));
  return { d, path, scheduler: schedulerFor(d, opts) };
}

let ids = 7_000;
function schedulerFor(
  d: StoreDriver,
  opts: { concurrency?: number; reservationMs?: number } = {},
): Scheduler {
  const realStart = (taskId: string): Promise<StartResult> =>
    startTask(
      {
        store: d.store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () =>
          Promise.resolve({ user: userConfig(), packs: PACKS, manifests: MANIFESTS }),
        docs: {
          prompts: (names) =>
            Promise.resolve(names.map((name) => ({ name, content: `# ${name}\n` }))),
          attachments: () => Promise.resolve([]),
        },
        now: () => d.now,
        newId: () => uuidOf(ids++),
      },
      taskId,
    );
  return new Scheduler({
    store: d.store,
    clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
    start: realStart,
    newId: () => uuidOf(ids++),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    ...(opts.reservationMs === undefined ? {} : { reservationMs: opts.reservationMs }),
  });
}

const task = (n: number, over: Partial<CanonicalTask> = {}) =>
  buildTask({ id: uuidOf(n), source_key: `cli:${n}`, ...over });

async function confirmed(d: StoreDriver, t: CanonicalTask): Promise<void> {
  d.must(t.id, { kind: 'create_task', task: t });
  proposeAndConfirm(d, t, await configuredSelection(t, 'full-review'));
}

/** Started on a slot of its own, then waits for a person: nothing slot-bound is left. */
function startedAndAsking(d: StoreDriver, t: CanonicalTask, capacity = 1): string {
  createGrantStart(d, t, 'full-review', {}, {}, capacity);
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  return askAgain(d, t);
}

function askAgain(d: StoreDriver, t: CanonicalTask): string {
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions: ['Postgres or SQLite?'] }),
  );
  return d.task(t.id).wait?.detail['question_id'] as string;
}

const answer = (d: StoreDriver, t: CanonicalTask, qid: string) =>
  d.must(t.id, { kind: 'answer', question_id: qid as Uuid, answer: 'SQLite' });

const HEAD = 'a'.repeat(40);

/** Started on a slot of its own, through publish, PR and review; `await_ci` is left pending. */
function toCi(d: StoreDriver, t: CanonicalTask): void {
  createGrantStart(d, t, 'full-review', {}, {}, 1);
  toPublish(d, t, HEAD);
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: HEAD,
  });
  reviewToCi(d, t.id);
}

/** CI still running: the task waits on a `ci_poll` timer. */
function ciPending(d: StoreDriver, t: CanonicalTask): void {
  d.complete(
    t.id,
    d.pendingOne(t.id, 'await_ci').id,
    'succeeded',
    ciData(HEAD, { build: 'success', test: 'pending' }),
  );
  expect(d.task(t.id).wait?.detail.code).toBe('checks_incomplete');
}

const types = (d: StoreDriver, t: CanonicalTask) => d.store.readEvents(t.id).map((e) => e.type);

describe('a task waiting outside keeps its slot reserved and lends it (FR-044.02)', () => {
  it('lends the reservation to one task that never started; a second one keeps waiting', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    startedAndAsking(d, a);
    expect(d.store.readSlots()).toMatchObject([{ holder_task_id: a.id, reserved_at: d.now }]);
    expect(types(d, a)).toContain('ExecutionReserved');
    expect(types(d, a)).not.toContain('ExecutionReleased');

    const b = task(2, { priority: 5 });
    const c = task(3);
    await confirmed(d, b);
    await confirmed(d, c);
    const r = await scheduler.tick();

    expect(r.granted).toEqual([]);
    expect(r.lent).toEqual([b.id]);
    expect(r.started.map((s) => s.task_id)).toEqual([b.id]);
    expect(d.store.readSlots()).toMatchObject([{ holder_task_id: a.id, borrower_task_id: b.id }]);
    expect(d.store.readLoans()).toMatchObject([{ borrower_task_id: b.id, lender_task_id: a.id }]);
    expect(d.task(b.id)).toMatchObject({
      status: 'RUNNING',
      execution: { holding: { lender_task_id: a.id } },
    });
    // The loan runs slot-bound work like a slot of its own.
    expect(d.pending(b.id, 'prepare')).toHaveLength(1);
    // One loan per reservation: c stays READY in the queue.
    expect(d.task(c.id)).toMatchObject({ status: 'READY', execution: { holding: null } });
    expect(d.task(c.id).execution.request).not.toBeNull();
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('the holder that comes back runs at once; the borrower ends its step, then waits for a slot of its own (FR-044.04)', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    const qid = startedAndAsking(d, a);
    const b = task(2);
    await confirmed(d, b);
    await scheduler.tick();
    expect(d.store.readLoans()).toHaveLength(1);

    // a gets its answer while b runs: no queue, no execution_slot wait, b is not stopped.
    answer(d, a, qid);
    expect(d.task(a.id)).toMatchObject({ status: 'RUNNING', wait: null });
    expect(d.task(a.id).execution.holding?.reserved_at).toBeUndefined();
    expect(d.pending(a.id, 'start_agent')).toHaveLength(1);
    expect(types(d, a)).toContain('ExecutionReclaimed');
    expect(types(d, a).filter((t) => t === 'ExecutionGranted')).toHaveLength(1);
    expect(d.task(b.id)).toMatchObject({ status: 'RUNNING' });
    expect(d.pending(b.id, 'prepare')).toHaveLength(1);

    // Two tasks run on one slot for now; nothing new is lent or granted meanwhile.
    const c = task(3);
    await confirmed(d, c);
    const r = await scheduler.tick();
    expect(r.granted).toEqual([]);
    expect(r.lent).toEqual([]);

    // b finishes its step; its next slot-bound work waits for a slot of its own.
    d.complete(b.id, d.pendingOne(b.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    expect(d.task(b.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'execution_slot' } },
      execution: { holding: null, request: { group: 'resumed' } },
    });
    expect(d.pending(b.id, 'start_agent')).toEqual([]);
    expect(d.store.readLoans()).toEqual([]);
    const released = d.store.readEvents(b.id).filter((e) => e.type === 'ExecutionReleased');
    expect(released.map((e) => e.payload['reason'])).toEqual(['loan_ended']);
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('a holder that waits again lends again, but only to a task that never started', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    const qid = startedAndAsking(d, a);
    const b = task(2);
    await confirmed(d, b);
    await scheduler.tick();
    answer(d, a, qid);
    d.complete(b.id, d.pendingOne(b.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    const c = task(3);
    await confirmed(d, c);

    askAgain(d, a);
    await scheduler.tick();
    // b already started, so it waits for a slot of its own; c borrows.
    expect(d.store.readLoans()).toMatchObject([{ borrower_task_id: c.id, lender_task_id: a.id }]);
    expect(d.task(b.id).wait?.detail.code).toBe('execution_slot');
  });

  it('CI polls of the holder keep its reservation, its time and the loan as they are', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    toCi(d, a);
    ciPending(d, a);
    const reservedAt = d.now;
    expect(d.store.readSlots()).toMatchObject([{ holder_task_id: a.id, reserved_at: reservedAt }]);
    const b = task(2);
    await confirmed(d, b);
    await scheduler.tick();
    expect(d.store.readLoans()).toMatchObject([{ borrower_task_id: b.id }]);

    for (let i = 0; i < 3; i++) {
      d.now += 60_000;
      d.fire();
      // The poll runs: a GitHub read, no slot-bound work, so the reservation is not taken back.
      expect(d.pending(a.id, 'await_ci')).toHaveLength(1);
      expect(d.task(a.id).execution.holding?.reserved_at).toBe(reservedAt);
      ciPending(d, a);
    }
    expect(types(d, a)).not.toContain('ExecutionReclaimed');
    expect(types(d, a).filter((x) => x === 'ExecutionReserved')).toHaveLength(1);
    expect(d.store.readSlots()).toMatchObject([
      { holder_task_id: a.id, reserved_at: reservedAt, borrower_task_id: b.id },
    ]);
    // b's loan still holds: its next slot-bound work runs on it.
    d.complete(b.id, d.pendingOne(b.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    expect(d.task(b.id)).toMatchObject({
      status: 'RUNNING',
      execution: { holding: { lender_task_id: a.id } },
    });
    expect(d.pending(b.id, 'start_agent')).toHaveLength(1);
  });

  it('a loan of a reservation the holder took back stays ended when it reserves again', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    const qid = startedAndAsking(d, a);
    const b = task(2);
    await confirmed(d, b);
    await scheduler.tick();

    // a comes back and runs its agent on its own slot, then asks again, all while b is in prepare.
    answer(d, a, qid);
    d.now += 1_000;
    askAgain(d, a);
    expect(d.store.readSlots()).toMatchObject([{ holder_task_id: a.id, reserved_at: d.now }]);

    d.complete(b.id, d.pendingOne(b.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    expect(d.task(b.id)).toMatchObject({
      status: 'WAITING',
      wait: { detail: { code: 'execution_slot' } },
      execution: { holding: null, request: { group: 'resumed' } },
    });
    expect(d.pending(b.id, 'start_agent')).toEqual([]);
    expect(d.store.readLoans()).toEqual([]);
  });

  it('a borrower that waits outside gives the loan back and keeps no reservation', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    startedAndAsking(d, a);
    const b = task(2);
    await confirmed(d, b);
    await scheduler.tick();

    d.complete(b.id, d.pendingOne(b.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    askAgain(d, b);
    expect(d.task(b.id)).toMatchObject({ status: 'WAITING', execution: { holding: null } });
    expect(d.store.readLoans()).toEqual([]);
    expect(d.store.readSlots()).toMatchObject([{ holder_task_id: a.id, borrower_task_id: null }]);
  });

  it('never lends to a task that depends on the holder', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    startedAndAsking(d, a);
    const dependent = task(2, { depends_on: [a.id] });
    await confirmed(d, dependent);
    await scheduler.tick();
    expect(d.store.readLoans()).toEqual([]);
    expect(d.task(dependent.id).execution.holding).toBeNull();
  });

  it('a paused holder gives its reservation back', () => {
    const { d } = setup();
    const a = task(1);
    startedAndAsking(d, a);
    d.must(a.id, { kind: 'pause', reason: 'later' }, { authz: authz(['operate'], 'owner') });
    expect(d.task(a.id).execution.holding).toBeNull();
    expect(d.store.readSlots()).toEqual([]);
  });

  it('with concurrency 2 each reservation lends once: at most 2N tasks run (FR-044.01/02)', async () => {
    const { d, scheduler } = setup({ concurrency: 2 });
    const a1 = task(1);
    const a2 = task(2);
    startedAndAsking(d, a1, 2);
    startedAndAsking(d, a2, 2);
    expect(d.store.readSlots().map((s) => s.reserved_at)).toEqual([d.now, d.now]);
    const fresh = [task(3, { priority: 3 }), task(4, { priority: 2 }), task(5, { priority: 1 })];
    for (const t of fresh) await confirmed(d, t);

    const r = await scheduler.tick();
    expect(r.lent).toEqual([fresh[0]?.id, fresh[1]?.id]);
    expect(d.store.readLoans().map((l) => l.lender_task_id)).toEqual([a1.id, a2.id]);
    expect(d.task(fresh[2]?.id as string).status).toBe('READY');
    expect(d.store.readSlots().length + d.store.readLoans().length).toBe(4);
  });
});

describe('the reservation runs out (FR-044.02)', () => {
  it('past the reservation time the slot is free, and the holder queues by priority when it comes back', async () => {
    const { d, scheduler } = setup({ reservationMs: 2 * TTL });
    const a = task(1, { priority: 1 });
    const qid = startedAndAsking(d, a);

    d.now += TTL;
    expect((await scheduler.tick()).expired).toEqual([]);
    d.now += TTL;
    const higher = task(2, { priority: 9 });
    await confirmed(d, higher);
    const r = await scheduler.tick();
    expect(r.expired).toEqual([a.id]);
    // The free slot goes to the queue head as a slot of its own, not as a loan.
    expect(r.granted).toEqual([higher.id]);
    expect(r.lent).toEqual([]);
    expect(
      d.store
        .readEvents(a.id)
        .filter((e) => e.type === 'ExecutionReleased')
        .map((e) => e.payload['reason']),
    ).toEqual(['reservation_expired']);

    answer(d, a, qid);
    expect(d.task(a.id)).toMatchObject({
      status: 'WAITING',
      wait: { detail: { code: 'execution_slot' } },
      execution: { request: { group: 'resumed' } },
    });
  });

  it('an expiry read before the holder came back is ignored', () => {
    const { d } = setup();
    const a = task(1);
    const qid = startedAndAsking(d, a);
    const requestId = d.task(a.id).execution.holding?.request_id as Uuid;
    answer(d, a, qid);
    d.must(a.id, {
      kind: 'release_execution',
      request_id: requestId,
      reason: 'reservation_expired',
    });
    expect(d.task(a.id).execution.holding?.request_id).toBe(requestId);
    expect(d.store.readSlots()).toMatchObject([{ holder_task_id: a.id, reserved_at: null }]);
  });

  it('a borrower of an expired reservation ends its step and queues; the slot is granted by priority', async () => {
    const { d, scheduler } = setup({ reservationMs: TTL });
    const a = task(1);
    startedAndAsking(d, a);
    const b = task(2);
    await confirmed(d, b);
    await scheduler.tick();
    const c = task(3, { priority: 9 });
    await confirmed(d, c);

    d.now += TTL;
    const r = await scheduler.tick();
    expect(r.expired).toEqual([a.id]);
    expect(r.granted).toEqual([c.id]);
    // b is not stopped mid-step.
    expect(d.task(b.id).status).toBe('RUNNING');
    d.complete(b.id, d.pendingOne(b.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    expect(d.task(b.id)).toMatchObject({
      wait: { detail: { code: 'execution_slot' } },
      execution: { holding: null, request: { group: 'resumed' } },
    });
  });
});

describe('restart keeps reservations, loans and the reservation clock (FR-044.06)', () => {
  it('a reopened store replays to the same slots and loans, and expiry counts from the stored time', async () => {
    const first = setup({ reservationMs: 2 * TTL });
    const a = task(1);
    startedAndAsking(first.d, a);
    const reservedAt = first.d.now;
    const b = task(2);
    await confirmed(first.d, b);
    await first.scheduler.tick();
    const slots = first.d.store.readSlots();
    const loans = first.d.store.readLoans();
    first.d.store.close();

    const d = new StoreDriver(openFileStoreForTest(first.path));
    d.now = reservedAt + TTL;
    expect(d.store.verifyProjections().ok).toBe(true);
    expect(d.store.readSlots()).toEqual(slots);
    expect(d.store.readLoans()).toEqual(loans);
    const scheduler = schedulerFor(d, { reservationMs: 2 * TTL });
    expect((await scheduler.tick()).expired).toEqual([]);
    d.now = reservedAt + 2 * TTL;
    expect((await scheduler.tick()).expired).toEqual([a.id]);
  });
});

describe('explain tells the kinds of hold apart (FR-044.07)', () => {
  it('reserved, borrowed, running and queued', async () => {
    const { d, scheduler } = setup();
    const a = task(1);
    const qid = startedAndAsking(d, a);
    const b = task(2);
    const c = task(3);
    await confirmed(d, b);
    await confirmed(d, c);
    await scheduler.tick();
    const slot = (t: CanonicalTask) =>
      explainRuntime(d.task(t.id), d.store.readEvents(t.id), null, {
        now: d.now as EpochMs,
        recheckable: false,
        rt: null,
        queue_position: null,
        prerequisite: () => null,
        dependents: [],
        merge: null,
      }).slot;

    expect(slot(a).hold).toEqual({ kind: 'reserved', since: d.now, lender_task_id: null });
    expect(slot(b).hold).toMatchObject({ kind: 'borrowed', lender_task_id: a.id });
    expect(slot(c)).toMatchObject({ holding: false, hold: null, queued: { group: 'fresh' } });
    answer(d, a, qid);
    expect(slot(a).hold).toMatchObject({ kind: 'running', lender_task_id: null });
  });
});
