import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { choicesArb, drive, walk } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

describe('I04 khoá idempotency ở mức quyết định', () => {
  it('không hai EffectRequested cùng idem_key; khoá gắn project/task/revision; attempt mới có khoá mới; chạy lại giữ khoá', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        const { sim } = drive(policy, over, choices);
        const keys = new Map<string, string>();
        walk(sim.events, (before, ev, after) => {
          if (ev.type === 'EffectRequested') {
            const p = ev.payload;
            expect(keys.has(p.idem_key), p.idem_key).toBe(false);
            keys.set(p.idem_key, p.effect_id);
            expect(p.idem_key).toBe(`${p.kind}:${after.project}:${after.id}:r${after.revision}:${p.logical_id}`);
            if (p.kind === 'start_agent') expect(p.logical_id).toBe(p.attempt_id);
          }
          if (ev.type === 'EffectReconciled' && ev.payload.status === 'pending') {
            // Đưa lại vào hàng đợi là cùng effect, cùng khoá (R-17).
            expect(after.effects[ev.payload.effect_id]?.idem_key).toBe(before?.effects[ev.payload.effect_id]?.idem_key);
          }
        });
      }),
      propertyParams(),
    );
  });
});
