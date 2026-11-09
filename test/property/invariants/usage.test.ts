import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { UsageSchema } from '../../../src/domain/trigger.ts';
import { choicesArb, drive } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

describe('FR-024 labelled usage', () => {
  it('every finished attempt carries usage with a basis; unavailable usage never carries numbers', () => {
    let unavailable = 0;
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        const { sim } = drive(policy, over, choices);
        for (const ev of sim.events) {
          if (ev.type !== 'AttemptFinished') continue;
          const u = ev.payload.usage;
          expect(UsageSchema.safeParse(u).success).toBe(true);
          if (u.basis === 'unavailable') {
            unavailable++;
            expect(u.tokens).toBeUndefined();
            expect(u.cost).toBeUndefined();
          }
        }
        for (const a of Object.values(sim.s.attempts)) {
          if (a.status === 'finished') expect(a.usage?.basis).toBeDefined();
        }
      }),
      propertyParams(),
    );
    expect(unavailable).toBeGreaterThan(0);
  });

  it('the usage schema rejects zero in place of missing data', () => {
    fc.assert(
      fc.property(
        fc.record({
          tokens: fc.option(fc.nat(), { nil: undefined }),
          cost: fc.option(fc.nat(), { nil: undefined }),
        }),
        (n) => {
          const parsed = UsageSchema.safeParse({ basis: 'unavailable', ...n });
          expect(parsed.success).toBe(n.tokens === undefined && n.cost === undefined);
        },
      ),
      propertyParams(),
    );
  });
});
