import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { choicesArb, drive, walk } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

describe('I04 decision-level idempotency keys', () => {
  it('keys bind project/task/revision, change for new attempts, and survive requeueing', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        const { sim } = drive(policy, over, choices);
        const keys = new Map<string, string>();
        walk(sim.events, (before, ev, after) => {
          if (ev.type === 'EffectRequested') {
            const p = ev.payload;
            expect(keys.has(p.idem_key), p.idem_key).toBe(false);
            keys.set(p.idem_key, p.effect_id);
            expect(p.idem_key).toBe(
              `${p.kind}:${after.project}:${after.id}:r${after.revision}:${p.logical_id}`,
            );
            if (p.kind === 'start_agent') expect(p.logical_id).toBe(p.attempt_id);
          }
          if (ev.type === 'EffectReconciled' && ev.payload.status === 'pending') {
            expect(after.effects[ev.payload.effect_id]?.idem_key).toBe(
              before?.effects[ev.payload.effect_id]?.idem_key,
            );
          }
        });
      }),
      propertyParams(),
    );
  });
});
