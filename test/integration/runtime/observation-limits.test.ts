import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/adapters/ports.ts';
import {
  dueTasks,
  observationDue,
  observationRound,
  ObservationCoordinator,
  type ObservedFacts,
} from '../../../src/daemon/observation.ts';
import { DEFAULT_RUNTIME_LIMITS } from '../../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { A, ci, merge, observation, toGreen } from '../../support/observation.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// Daemon side of the PR observation (T061, FR-043.01–06/13, US2.9–US2.11): which tasks get an automatic
// round, coalesced reads, expiry without I/O, round bounds; the engine side is in feature-002-fixes.

const tempDir = useTempDir('cusr-observe-');
const DAY = 86_400_000;
const B = 'b'.repeat(40);
const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));

function clockOf(d: StoreDriver): Clock {
  return { now: () => d.now as EpochMs, monotonic: () => d.now };
}

let ids = 70_000;
const newId = () => uuidOf(ids++);

/** A coordinator whose reads answer with `facts(taskId)` and count the calls. */
function fakeReads(facts: (taskId: string) => ObservedFacts) {
  const calls: string[] = [];
  const coordinator = new ObservationCoordinator((taskId, _ref, source) => {
    calls.push(`${taskId}:${source}`);
    return Promise.resolve(facts(taskId));
  });
  return { calls, coordinator };
}

function greenObserved(d: StoreDriver, t: CanonicalTask): void {
  toGreen(d, t);
  d.must(
    t.id,
    observation(d, t, 'open', A, {
      ci: ci(A, { build: 'success', test: 'success' }),
    }),
  );
}

describe('observation service (T061)', () => {
  it('runs afterRead once a read committed its facts, and not after a failed read', async () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(t.id, observation(d, t, 'open', A));
    d.now = d.task(t.id).observation?.budget.next_due_at ?? 0;
    const after: unknown[] = [];
    const round = (failure: string | null) =>
      observationRound({
        store: d.store,
        clock: clockOf(d),
        coordinator: fakeReads(() => ({
          facts: failure === null ? [observation(d, t, 'open', A)] : [],
          failure,
        })).coordinator,
        newId,
        afterRead: (id) => {
          after.push([id, d.task(t.id).observation?.budget.count]);
          return Promise.resolve();
        },
      });
    await round('unreadable');
    expect(after).toEqual([]);
    await round(null);
    expect(after).toEqual([[t.id, 2]]);
  });

  it('runs one automatic round per due task, never ahead of its schedule, and never while the CI wait polls', async () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    // No window yet: the CI wait's own reads open it.
    expect(observationDue(d.task(t.id), d.now)).toBeNull();
    d.must(t.id, observation(d, t, 'open', A));
    expect(observationDue(d.task(t.id), d.now)).toBeNull();
    const due = d.task(t.id).observation?.budget.next_due_at ?? 0;
    expect(due - d.now).toBe(DEFAULT_RUNTIME_LIMITS.poll_initial_ms);
    d.now = due;
    const { calls, coordinator } = fakeReads(() => ({
      facts: [observation(d, t, 'open', A)],
      failure: null,
    }));
    const reports = await observationRound({
      store: d.store,
      clock: clockOf(d),
      coordinator,
      newId,
    });
    expect(calls).toEqual([`${t.id}:timer`]);
    expect(reports).toMatchObject([
      {
        task_id: t.id,
        kind: 'observe',
        outcomes: [
          {
            kind: 'observation_result',
            outcome: { decision: { kind: 'accepted' } },
          },
        ],
      },
    ]);
    // Same digest: the cadence grows; nothing is due again right away.
    expect(d.task(t.id).observation?.budget).toMatchObject({
      count: 2,
      cadence_index: 1,
    });
    expect(
      await observationRound({
        store: d.store,
        clock: clockOf(d),
        coordinator,
        newId,
      }),
    ).toEqual([]);
  });

  it('leaves a task to its CI wait while an await_ci or ci_poll timer is live', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'direct-pr');
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'pending' }),
      }),
    );
    expect(d.task(t.id).wait?.detail.code).toBe('checks_incomplete');
    d.now += 10 * 60_000;
    expect(observationDue(d.task(t.id), d.now)).toBeNull();
  });

  it('takes over from a pending CI poll that a blocker holds: an incomplete merge is observed again until its proof (FR-041.01)', async () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'direct-pr');
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'pending' }),
      }),
    );
    d.now += 60_000;
    d.fire();
    const poll = d.pendingOne(t.id, 'await_ci');
    d.must(t.id, observation(d, t, 'merged', A, { source: 'recheck', merge_proof: false }));
    expect(d.claim(poll.id)).toMatchObject({
      ok: false,
      error: { reason: 'merge_evidence_incomplete' },
    });
    d.now = Math.max(d.now, d.task(t.id).observation?.budget.next_due_at ?? d.now);
    expect(observationDue(d.task(t.id), d.now)).toBe('observe');
    const { calls, coordinator } = fakeReads(() => ({
      facts: [],
      failure: null,
    }));
    await observationRound({
      store: d.store,
      clock: clockOf(d),
      coordinator,
      newId,
    });
    expect(calls).toEqual([`${t.id}:timer`]);
    merge(d, t, A);
    expect(d.task(t.id).completion).not.toBeNull();
  });

  it('coalesces reads of the same task under the same ref; another ref reads after it under its own (#267)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const refs: string[] = [];
    let active = 0;
    let most = 0;
    const coordinator = new ObservationCoordinator(async (_id, ref) => {
      refs.push(ref);
      most = Math.max(most, ++active);
      await gate;
      active--;
      return { facts: [], failure: null };
    });
    const a = coordinator.observe('t1', 'timer-round', 'timer');
    const b = coordinator.observe('t1', 'timer-round', 'timer');
    const c = coordinator.observe('t1', 'cancel:x', 'recheck');
    expect(coordinator.busy('t1')).toBe(true);
    release();
    expect(await a).toBe(await b);
    await c;
    expect(refs).toEqual(['timer-round', 'cancel:x']);
    expect(most).toBe(1);
    expect(coordinator.busy('t1')).toBe(false);
  });

  it('expires a window past its deadline without reading GitHub, even after a restart; nothing polls after that', async () => {
    const d = setup();
    const t = buildTask();
    greenObserved(d, t);
    // The last read shows another head, so the window cannot be extended (#248).
    d.must(t.id, observation(d, t, 'open', B, { source: 'recheck' }));
    d.now += 31 * DAY;
    const { calls, coordinator } = fakeReads(() => ({
      facts: [],
      failure: null,
    }));
    const reports = await observationRound({
      store: d.store,
      clock: clockOf(d),
      coordinator,
      newId,
    });
    expect(calls).toEqual([]);
    expect(reports).toMatchObject([{ kind: 'expire', outcomes: [{ kind: 'observation_due' }] }]);
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'observation_expired' } },
      observation: { expired: true },
    });
    d.now += DAY;
    expect(dueTasks(d.store, d.now)).toEqual([]);
    // A replayed (restarted) store sees the same: still expired, no rounds.
    expect(observationDue(d.task(t.id), d.now)).toBeNull();
  });

  it('a merge, or a terminal task, stops the schedule (FR-043.13)', () => {
    const d = setup();
    const t = buildTask();
    greenObserved(d, t);
    merge(d, t, A);
    expect(d.task(t.id).status).toBe('DONE');
    d.now += 2 * DAY;
    expect(observationDue(d.task(t.id), d.now)).toBeNull();
  });

  it('a round is bounded in time: tasks beyond the round window wait for the next round', async () => {
    const d = setup();
    const tasks = [
      buildTask({ id: uuidOf(201), source_key: 'cli:1' }),
      buildTask({ id: uuidOf(202), source_key: 'cli:2' }),
    ];
    for (const t of tasks) greenObserved(d, t);
    d.now += 10 * 60_000;
    expect(
      dueTasks(d.store, d.now)
        .map((x) => x.id)
        .sort(),
    ).toEqual(tasks.map((t) => t.id).sort());
    const { calls, coordinator } = fakeReads((id) => {
      // Each read takes the whole round window.
      d.now += DEFAULT_RUNTIME_LIMITS.observation_round_ms;
      const t = tasks.find((x) => x.id === id) as CanonicalTask;
      return { facts: [observation(d, t, 'open', A)], failure: null };
    });
    await observationRound({
      store: d.store,
      clock: clockOf(d),
      coordinator,
      newId,
    });
    expect(calls).toHaveLength(1);
    await observationRound({
      store: d.store,
      clock: clockOf(d),
      coordinator,
      newId,
    });
    expect(calls).toHaveLength(2);
  });
});
