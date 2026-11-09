import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_LIMITS, type RuntimeLimits } from '../../../src/domain/runtime.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { cadenceDelay } from '../../../src/engine/observation.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask } from '../../support/builders.ts';
import { A, observation, toGreen } from '../../support/observation.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { HEAVY_PROPERTY_TIMEOUT_MS } from '../../support/timeouts.ts';
import { propertyParams } from '../arbitraries/policies.ts';

// FR-043.01–07/12/13, research R-04: a finite observation window per PR, fixed at its first observation
// unless it runs out while the PR is open on the task's head, which extends it (#248); cadence grows to a
// cap and only a changed remote resets it; only automatic rounds of the current generation count; a
// recheck or a stale round never moves the window; expiry is final.

describe('observation cadence (FR-043.03)', () => {
  it('stays within [initial, max] and never shrinks as unchanged rounds go by', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 600_000 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 7_200_000 }),
        fc.integer({ min: 0, max: 64 }),
        (initial, factor, extra, index) => {
          const l = {
            poll_initial_ms: initial,
            poll_factor: factor,
            poll_max_ms: initial + extra,
          };
          const d = cadenceDelay(l, index);
          expect(d).toBeGreaterThanOrEqual(initial);
          expect(d).toBeLessThanOrEqual(l.poll_max_ms);
          expect(cadenceDelay(l, index + 1)).toBeGreaterThanOrEqual(d);
        },
      ),
      propertyParams(200),
    );
  });

  it('defaults: 60 s, doubling, capped at one hour', () => {
    expect([0, 1, 2, 5, 6, 30].map((i) => cadenceDelay(DEFAULT_RUNTIME_LIMITS, i))).toEqual([
      60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
  });
});

type Op =
  | { kind: 'advance'; ms: number }
  | { kind: 'round'; changed: boolean; status: 'open' | 'closed' | 'unknown' }
  | { kind: 'stale_round' }
  | { kind: 'recheck_round' }
  | { kind: 'due' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('advance' as const),
    ms: fc.integer({ min: 1, max: 40 * 60_000 }),
  }),
  fc.record({
    kind: fc.constant('round' as const),
    changed: fc.boolean(),
    status: fc.constantFrom(
      'open' as const,
      'open' as const,
      'closed' as const,
      'unknown' as const,
    ),
  }),
  fc.constant({ kind: 'stale_round' as const }),
  fc.constant({ kind: 'recheck_round' as const }),
  fc.constant({ kind: 'due' as const }),
);

/** Small caps so a run reaches both ends of the window. */
const LIMITS: RuntimeLimits = {
  ...DEFAULT_RUNTIME_LIMITS,
  observation_max_ms: 3 * 3_600_000,
  observation_max_rounds: 6,
  poll_initial_ms: 60_000,
  poll_factor: 2,
  poll_max_ms: 600_000,
  observation_round_ms: 60_000,
};

describe('observation window (FR-043.04–06)', () => {
  it(
    'bounded rounds and time; fixed start; only an open, unchanged PR extends the window; recheck and stale rounds never count; expiry is final; replay agrees',
    () => {
      fc.assert(
        fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
          const d = new StoreDriver(openMemoryStore());
          const t = buildTask();
          toGreen(
            d,
            t,
            'full-review',
            { limits: { max_wall_ms: 100 * 3_600_000 } },
            { limits: LIMITS },
          );
          d.must(t.id, observation(d, t, 'open', A));
          const first = d.task(t.id).observation;
          if (first === null) throw new Error('window not opened');
          let digest = 0;
          let expiredSeen = false;
          for (const op of ops) {
            const before = d.task(t.id).observation as NonNullable<TaskState['observation']>;
            switch (op.kind) {
              case 'advance':
                d.now += op.ms;
                break;
              case 'round':
                if (op.changed) digest++;
                d.must(
                  t.id,
                  observation(d, t, op.status, op.status === 'unknown' ? null : A, {
                    digest: hashCanonical(`r${digest}`),
                  }),
                );
                break;
              case 'stale_round':
                d.must(
                  t.id,
                  observation(d, t, 'open', A, {
                    generation: before.budget.generation + 7,
                  }),
                );
                break;
              case 'recheck_round':
                d.must(t.id, observation(d, t, 'open', A, { source: 'recheck' }));
                break;
              case 'due':
                d.must(t.id, { kind: 'observation_due' });
                break;
            }
            const after = d.task(t.id).observation as NonNullable<TaskState['observation']>;
            const b = after.budget;
            const openOnHead = after.last?.status === 'open' && after.last.observed_head === A;
            expect(b.started_at).toBe(first.budget.started_at);
            const extended = b.max_count !== before.budget.max_count;
            if (extended) {
              expect(openOnHead).toBe(true);
              expect(b.deadline_at).toBe(d.now + LIMITS.observation_max_ms);
              expect(b.max_count).toBe(b.count + LIMITS.observation_max_rounds);
            } else {
              expect(b.deadline_at).toBe(before.budget.deadline_at);
            }
            expect(b.count).toBeLessThanOrEqual(b.max_count);
            if (b.next_due_at !== null) {
              expect(b.next_due_at).toBeLessThanOrEqual(b.deadline_at);
              // An extension without a read asks for a round right away.
              if (!(extended && op.kind === 'due'))
                expect(b.next_due_at - (after.last?.observed_at ?? 0)).toBeLessThanOrEqual(
                  LIMITS.poll_max_ms,
                );
              else expect(b.next_due_at).toBe(d.now);
            }
            // Only an accepted automatic round of the current generation moves the window.
            if (op.kind !== 'round') {
              expect(b.count).toBe(before.budget.count);
              expect(b.generation).toBe(before.budget.generation);
            }
            if (op.kind === 'round' && !before.expired) {
              expect(b.count).toBe(before.budget.count + 1);
              expect(b.generation === before.budget.generation + 1 || after.expired).toBe(true);
            }
            if (expiredSeen) {
              expect(after.expired).toBe(true);
              expect(b.count).toBe(before.budget.count);
              expect(b.next_due_at).toBeNull();
            }
            if (after.expired) expiredSeen = true;
            if (after.expired && !before.expired) {
              expect(openOnHead).toBe(false);
              expect(d.task(t.id).blockers.map((x) => x.code)).toContain('observation_expired');
            }
          }
          // Restart rebuilds the same window from the log.
          expect(replay(d.store.readEvents(t.id))?.observation).toEqual(d.task(t.id).observation);
        }),
        propertyParams(40),
      );
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );
});
