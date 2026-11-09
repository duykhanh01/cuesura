import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_ENVELOPE_IDS } from '../../../src/domain/trigger.ts';
import { choicesArb, drive, walk } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

function newIds(payload: Record<string, unknown>, type: string): string[] {
  switch (type) {
    case 'EffectRequested':
      return [payload['effect_id'] as string];
    case 'AttemptRequested':
      return [payload['attempt_id'] as string, payload['reservation_id'] as string];
    case 'QuestionAsked':
      return [payload['question_id'] as string];
    case 'ApprovalRequested':
      return [payload['approval_id'] as string];
    case 'TimerArmed':
      return [payload['timer_id'] as string];
    default:
      return [];
  }
}

describe('I07 bounded execution', () => {
  it('bounds step visits, budgets, IDs per decision, and attempt deadlines', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        const { sim } = drive(policy, over, choices);
        const wf = sim.policy!.workflow;
        let deadlineFired = false;
        walk(sim.events, (_before, ev, after) => {
          for (const [step, n] of Object.entries(after.step_visits)) {
            const max = wf.steps[step]?.max_visits;
            if (max === undefined) continue;
            // Visits lost to the harness come back (#247), never more than the attempts that lost them.
            const credited = after.visit_credits?.[step]?.visits ?? 0;
            const lost = Object.values(after.attempts).filter(
              (a) =>
                a.step === step &&
                ['infra', 'rate_limit', 'auth_config'].includes(a.outcome?.class ?? ''),
            ).length;
            expect(credited, `credited ${step}`).toBeLessThanOrEqual(lost);
            expect(n, step).toBeLessThanOrEqual(max + credited);

            const attempts = Object.values(after.attempts).filter((a) => a.step === step).length;
            expect(attempts, `attempts ${step}`).toBeLessThanOrEqual(n);
          }
          const b = after.budget.agent_runs;
          expect(b.used + b.reserved).toBeLessThanOrEqual(b.limit ?? Infinity);
          expect(b.reserved).toBeGreaterThanOrEqual(0);
          if (ev.type === 'TimerFired' && after.timers[ev.payload.timer_id]?.kind === 'deadline')
            deadlineFired = true;
          if (ev.type === 'TimerArmed' && ev.payload.kind === 'deadline') deadlineFired = false;
          if (deadlineFired) expect(ev.type).not.toBe('AttemptRequested');
        });
        for (const d of sim.decisions) {
          if (d.kind !== 'accepted') continue;
          const ids = new Set(
            d.events.flatMap((e) => newIds(e.payload as Record<string, unknown>, e.type)),
          );
          expect(ids.size).toBeLessThanOrEqual(MAX_ENVELOPE_IDS);
        }
      }),
      propertyParams(),
    );
  });
});
