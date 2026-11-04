import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FailureDataSchema } from '../../../src/domain/trigger.ts';
import { choicesArb, drive, walk } from '../arbitraries/signals.ts';
import {
  escalationPolicyArb,
  policyArb,
  propertyParams,
  taskOverArb,
} from '../arbitraries/policies.ts';
import { HEAVY_PROPERTY_TIMEOUT_MS } from '../../support/timeouts.ts';

const anyPolicyArb = fc.oneof(escalationPolicyArb, policyArb);

describe('I09, FR-022 budget reservations', () => {
  it(
    'used + reserved never exceeds the limit; unknown keeps its hold; invalidation releases it',
    () => {
      fc.assert(
        fc.property(anyPolicyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
          const { sim, trace } = drive(policy, over, choices);
          walk(sim.events, (_before, _ev, after) => {
            const b = after.budget.agent_runs;
            expect(b.used + b.reserved).toBeLessThanOrEqual(b.limit ?? Infinity);
            expect(b.reserved).toBeGreaterThanOrEqual(0);
          });
          // Reservation and effect settle within one decision, so they are compared after each decision.
          for (const t of trace) {
            const after = t.after;
            if (after === null) continue;
            const b = after.budget.agent_runs;
            for (const [id, r] of Object.entries(after.budget.reservations)) {
              const e = after.effects[r.effect_id];
              if (e === undefined) continue;
              if (e.status === 'pending' || e.status === 'started' || e.status === 'unknown')
                expect(r.status, id).toBe('held');
              if (e.status === 'invalidated') expect(r.status, id).toBe('released');
            }
            const held = Object.values(after.budget.reservations)
              .filter((r) => r.status === 'held')
              .reduce((n, r) => n + r.units, 0);
            expect(b.reserved).toBe(held);
          }
        }),
        propertyParams(),
      );
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );

  it(
    'every invoked agent run is consumed, rate-limited runs included; a run never invoked is released',
    () => {
      let rateLimited = 0;
      fc.assert(
        fc.property(anyPolicyArb, taskOverArb, choicesArb(160, 60), (policy, over, choices) => {
          const { trace } = drive(policy, over, choices, 1, {
            failureFocus: true,
          });
          for (const t of trace) {
            const trig = t.trigger;
            if (
              trig?.kind !== 'effect_result' ||
              trig.outcome !== 'failed' ||
              t.before === null ||
              t.after === null
            )
              continue;
            const before = t.before.effects[trig.effect_id];
            const after = t.after.effects[trig.effect_id];
            if (
              after?.kind !== 'start_agent' ||
              before?.status === 'failed' ||
              after.status !== 'failed'
            )
              continue;
            const f = FailureDataSchema.parse(trig.data);
            if (f.failure_class === 'rate_limit' && f.invoked !== false) rateLimited++;
            const r = t.after.budget.reservations[after.reservation_id as string];
            expect(r?.status).toBe(f.invoked === false ? 'released' : 'consumed');
          }
        }),
        propertyParams(),
      );
      expect(rateLimited).toBeGreaterThan(0);
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );
});
