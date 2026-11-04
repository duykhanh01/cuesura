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

// FR-044.01–07, SPEC.md §6.2: one daemon-wide slot, priority desc (default 0), resumed before fresh,
// then requested_at, then request_global_seq; a held slot is never preempted.

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
        const s = selectNext(q, null);
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
          expect(selectNext(shuffled, null)).toEqual(selectNext(q, null));
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

  it('never preempts: a held slot stays busy whatever waits behind it', () => {
    fc.assert(
      fc.property(queueArb, fc.integer({ min: 0, max: 20 }), (q, n) => {
        const holder = {
          holder_task_id: `holder-${n}`,
          request_id: `held-${n}`,
        };
        expect(selectNext(q, holder)).toEqual({
          kind: 'busy',
          holder_task_id: holder.holder_task_id,
        });
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
            expect(again.ok && again.value).toEqual({
              kind: 'busy',
              holder_task_id: g.value.task_id,
            });
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
});
