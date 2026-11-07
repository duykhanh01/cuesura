import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareRequests,
  orderQueue,
  selectNext,
  type SlotCandidate,
} from '../../../src/engine/execution-slot.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { propertyParams } from '../arbitraries/policies.ts';

// FR-044.01–07, SPEC.md §6.2: up to `runtime.concurrency` slots, priority desc (default 0), resumed before
// fresh, then requested_at, then request_global_seq; a held slot is never preempted.

/** Unique request IDs and global seqs, as the store guarantees. */
const queueArb = fc
  .array(
    fc.record({
      priority: fc.integer({ min: -3, max: 3 }),
      group: fc.constantFrom('fresh' as const, 'resumed' as const),
      requested_at: fc.integer({ min: 0, max: 5 }),
    }),
    { maxLength: 12 },
  )
  .chain((rows) =>
    fc
      .shuffledSubarray(
        rows.map((_, i) => i),
        { minLength: rows.length, maxLength: rows.length },
      )
      .map((seqs) =>
        rows.map((r, i): SlotCandidate => ({
          ...r,
          request_id: `req-${i}`,
          task_id: `task-${i}`,
          request_global_seq: (seqs[i] as number) * 7 + 1,
        })),
      ),
  );

/** Oracle written from the spec's tuple, independent of `compareRequests`. */
function key(r: SlotCandidate): [number, number, number, number] {
  return [-r.priority, r.group === 'resumed' ? 0 : 1, r.requested_at, r.request_global_seq];
}
function oracleFirst(q: readonly SlotCandidate[]): SlotCandidate | undefined {
  return [...q].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++)
      if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
    return 0;
  })[0];
}

describe('execution slot selector (FR-044.01–07)', () => {
  it('grants the request first by priority, resumed-before-fresh, requested_at, then request_global_seq', () => {
    fc.assert(
      fc.property(queueArb, (q) => {
        const s = selectNext(q, 0, 1);
        const want = oracleFirst(q);
        expect(s).toEqual(
          want === undefined ? { kind: 'empty' } : { kind: 'grant', request: want },
        );
      }),
      propertyParams(200),
    );
  });

  it('is a total order: the result does not depend on row order and no two requests compare equal', () => {
    fc.assert(
      fc.property(
        queueArb.chain((q) =>
          fc.tuple(
            fc.constant(q),
            fc.shuffledSubarray(q, {
              minLength: q.length,
              maxLength: q.length,
            }),
          ),
        ),
        ([q, shuffled]) => {
          expect(orderQueue(shuffled)).toEqual(orderQueue(q));
          expect(selectNext(shuffled, 0, 1)).toEqual(selectNext(q, 0, 1));
          for (const a of q) {
            for (const b of q) {
              if (a === b) expect(compareRequests(a, b)).toBe(0);
              else {
                expect(compareRequests(a, b)).not.toBe(0);
                expect(Math.sign(compareRequests(a, b))).toBe(-Math.sign(compareRequests(b, a)));
              }
            }
          }
        },
      ),
      propertyParams(100),
    );
  });

  it('never preempts: with every slot held the selector stays busy whatever waits behind it', () => {
    fc.assert(
      fc.property(
        queueArb,
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 4 }),
        (q, capacity, extra) => {
          expect(selectNext(q, capacity + extra, capacity)).toEqual({
            kind: 'busy',
            holders: capacity + extra,
          });
        },
      ),
      propertyParams(100),
    );
  });

  it('grants below capacity exactly as with a free slot', () => {
    fc.assert(
      fc.property(queueArb, fc.integer({ min: 2, max: 8 }), (q, capacity) => {
        for (let held = 0; held < capacity; held++)
          expect(selectNext(q, held, capacity)).toEqual(selectNext(q, 0, 1));
      }),
      propertyParams(100),
    );
  });

  it('the store grants one holder at a time, in selector order, and releasing hands the slot to the next', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            priority: fc.integer({ min: -2, max: 2 }),
            gap: fc.integer({ min: 0, max: 2 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (specs) => {
          const d = new StoreDriver(openMemoryStore());
          const ids: string[] = [];
          specs.forEach((sp, i) => {
            const t = buildTask({
              id: uuidOf(i + 1),
              source_key: `cli:t${i}`,
              priority: sp.priority,
            });
            ids.push(t.id);
            d.must(t.id, { kind: 'create_task', task: t });
            d.must(t.id, { kind: 'request_execution' });
            d.now += sp.gap;
          });
          const expectedOrder = d.store.readQueue(100).map((r) => r.task_id);
          const granted: string[] = [];
          for (let i = 0; i < specs.length; i++) {
            const g = d.store.grantNext(d.now as EpochMs);
            if (!g.ok || g.value.kind !== 'decided')
              throw new Error(`grant ${i}: ${JSON.stringify(g)}`);
            expect(g.value.outcome.decision.kind).toBe('accepted');
            granted.push(g.value.task_id);
            // A second grant while the slot is held is refused, not stacked.
            const again = d.store.grantNext(d.now as EpochMs);
            expect(again.ok && again.value).toEqual({ kind: 'busy', holders: 1 });
            d.must(g.value.task_id, {
              kind: 'release_execution',
              request_id: g.value.request_id as Uuid,
              reason: 'yielded',
            });
            d.now += 1;
          }
          expect(granted).toEqual(expectedOrder);
          expect(new Set(granted)).toEqual(new Set(ids));
          expect(d.store.verifyProjections()).toMatchObject({ ok: true });
        },
      ),
      propertyParams(25),
    );
  });

  it('with capacity N the store grants N holders in selector order, never more, and a release frees one', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(fc.integer({ min: -2, max: 2 }), { minLength: 1, maxLength: 7 }),
        (capacity, priorities) => {
          const d = new StoreDriver(openMemoryStore());
          priorities.forEach((priority, i) => {
            const t = buildTask({ id: uuidOf(i + 1), source_key: `cli:t${i}`, priority });
            d.must(t.id, { kind: 'create_task', task: t });
            d.must(t.id, { kind: 'request_execution' });
            d.now += 1;
          });
          const expectedOrder = d.store.readQueue(100).map((r) => r.task_id);
          const granted: string[] = [];
          for (;;) {
            const g = d.store.grantNext(d.now as EpochMs, [], { capacity });
            if (!g.ok) throw new Error(JSON.stringify(g));
            if (g.value.kind !== 'decided') break;
            expect(g.value.outcome.decision.kind).toBe('accepted');
            granted.push(g.value.task_id);
          }
          const n = Math.min(capacity, priorities.length);
          expect(granted).toEqual(expectedOrder.slice(0, n));
          expect(d.store.readSlots()).toHaveLength(n);
          if (priorities.length > capacity) {
            // The cap is read per grant: a raised cap lets one more in, and back at the old cap the
            // store is busy until a holder releases; replay stays consistent either way.
            const late = d.store.grantNext(d.now as EpochMs, [], { capacity: capacity + 1 });
            expect(late.ok && late.value.kind).toBe('decided');
            expect(d.store.readSlots()).toHaveLength(n + 1);
            const full = d.store.grantNext(d.now as EpochMs, [], { capacity });
            expect(full.ok && full.value).toEqual({ kind: 'busy', holders: n + 1 });
            const first = d.store.readSlots()[0];
            if (first === undefined) throw new Error('no holder');
            d.must(first.holder_task_id, {
              kind: 'release_execution',
              request_id: first.request_id as Uuid,
              reason: 'yielded',
            });
            expect(d.store.readSlots()).toHaveLength(n);
          }
          expect(d.store.verifyProjections()).toMatchObject({ ok: true });
        },
      ),
      propertyParams(25),
    );
  });
});
