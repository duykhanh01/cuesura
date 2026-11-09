import { describe, expect, it } from 'vitest';
import { AttentionDesk } from '../../../src/application/attention.ts';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { createDeputyAbsent, DEPUTY_ABSENT_ACTOR } from '../../../src/daemon/deputy-absent.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';

// 007 FR-004, R-11: past the ladder the task waits; with no deputy configured the daemon ends it.

/** A coder whose every run times out on a ladder of one rung. */
function pastLadder() {
  const d = new StoreDriver(openMemoryStore());
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr', {
    roles: { coder: { model: 'sonnet', effort: 'medium', ladder: [] } },
  } as never);
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  for (let i = 0; i < 2; i++)
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'timeout',
      invoked: true,
      usage: { basis: 'unavailable' },
    });
  expect(d.task(t.id).wait?.detail).toMatchObject({ code: 'ladder_exhausted', step: 'code' });
  let n = 0;
  const absent = (configured: boolean) =>
    createDeputyAbsent({
      store: d.store,
      clock: { now: () => d.now as EpochMs },
      newId: () => uuidOf(50_000 + ++n),
      configured: () => Promise.resolve(configured),
    });
  return { d, t, absent };
}

describe('a wait past the ladder with no deputy (R-11)', () => {
  it('ends with task fail as system:deputy-absent, with the reason #247 gave', async () => {
    const { d, t, absent } = pastLadder();
    const watch = absent(false);
    expect(watch.holds(d.task(t.id))).toBe(true);
    await watch.round();
    const s = d.task(t.id);
    expect(s.wait).toBeNull();
    // Nothing was published yet, so the draft-PR salvage of #247 runs first.
    expect(s.run.salvage).toMatchObject({ reason: 'ladder_exhausted:code' });
    const failed = d.store.readEvents(t.id).find((e) => e.type === 'FailureSalvageStarted');
    expect(failed?.actor).toBe(DEPUTY_ABSENT_ACTOR);
    // A second round finds nothing to do.
    const version = s.version;
    await watch.round();
    expect(d.task(t.id).version).toBe(version);
  });

  it('is not told to the assistant while the daemon has yet to end it', () => {
    const { d, t, absent } = pastLadder();
    const desk = (decider?: ReturnType<typeof absent>) =>
      new AttentionDesk({
        store: d.store,
        now: () => d.now,
        ...(decider === undefined ? {} : { decider }),
      });
    const caller = callerFor('assistant') as Caller;
    const peek = (x: AttentionDesk) => {
      const r = x.peek(caller);
      if (!r.ok) throw new Error(r.error.code);
      return r.value.tasks ?? [];
    };
    expect(peek(desk()).map((x) => x.task_id)).toEqual([t.id]);
    expect(peek(desk(absent(false)))).toEqual([]);
  });

  it('leaves the wait to the deputy when one is configured', async () => {
    const { d, t, absent } = pastLadder();
    const watch = absent(true);
    await watch.round();
    expect(d.task(t.id).wait?.detail.code).toBe('ladder_exhausted');
    expect(watch.holds(d.task(t.id))).toBe(false);
  });
});
