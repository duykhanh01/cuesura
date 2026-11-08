import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareLevel } from '../../../src/domain/policy.ts';
import { streakKey } from '../../../src/domain/state.ts';
import { countsTowardQuality } from '../../../src/engine/failure.ts';
import { floorRung } from '../../../src/engine/escalation.ts';
import { choicesArb, drive, walk } from '../arbitraries/signals.ts';
import {
  escalationPolicyArb,
  policyArb,
  propertyParams,
  taskOverArb,
} from '../arbitraries/policies.ts';
import { HEAVY_PROPERTY_TIMEOUT_MS } from '../../support/timeouts.ts';

const anyPolicyArb = fc.oneof(
  { weight: 3, arbitrary: escalationPolicyArb },
  { weight: 1, arbitrary: policyArb },
);

describe('I09 escalation stays within the frozen ladder and its approvals', () => {
  it(
    'rungs never drop, attempts stay on allowed rungs, and only quality failures or repeated timeouts escalate within the limits',
    () => {
      fc.assert(
        fc.property(anyPolicyArb, taskOverArb, choicesArb(160, 60), (policyOpts, over, choices) => {
          const { sim } = drive(policyOpts, over, choices, 1, {
            failureFocus: true,
          });
          const policy = sim.policy!;
          const limits = policy.limits;
          walk(sim.events, (before, ev, after) => {
            if (before !== null) {
              for (const [step, r] of Object.entries(before.rungs.by_step))
                expect(after.rungs.by_step[step], step).toBeGreaterThanOrEqual(r);
              if (before.rungs.floor_level !== null) {
                expect(after.rungs.floor_level).not.toBeNull();
                expect(
                  compareLevel(after.rungs.floor_level!, before.rungs.floor_level),
                ).toBeGreaterThanOrEqual(0);
              }
            }
            expect(after.budget.escalations.used).toBeLessThanOrEqual(
              limits.max_escalations ?? Infinity,
            );
            for (const streak of Object.values(after.failure_streaks)) {
              expect(streak.quality_tries).toBeLessThanOrEqual(
                limits.classes.quality_tries_per_rung,
              );
            }

            if (ev.type === 'AttemptRequested') {
              const { step, rung } = ev.payload;
              const ladder = policy.steps[step]!.ladder;
              expect(rung).toBeLessThan(ladder.length);
              const state = ladder[rung]!.state;
              expect(state).not.toBe('denied');
              if (state === 'needs_approval') {
                const granted = Object.values(after.approvals).some(
                  (a) =>
                    a.kind === 'escalation' &&
                    a.status === 'granted' &&
                    !a.revoked &&
                    a.step === step &&
                    a.rung === rung &&
                    a.revision === after.revision &&
                    a.policy_hash === after.policy_ref?.hash,
                );
                expect(granted, `approval for ${step}#${rung}`).toBe(true);
              }
              // No new attempt on a rung whose streak already asked for escalation.
              expect(before?.failure_streaks[streakKey(step, rung)]?.escalate ?? false).toBe(false);
            }

            if (ev.type === 'RungRaised') {
              const { step, from, to, reason } = ev.payload;
              expect(to).toBeGreaterThan(from);
              if (reason === 'quality') {
                expect(to).toBe(from + 1);
                expect(before?.failure_streaks[streakKey(step, from)]?.escalate).toBe(true);
              } else {
                expect(reason).toBe('floor');
                expect(to).toBe(floorRung(policy.steps[step]!, before?.rungs.floor_level ?? null));
              }
            }

            // An agent timeout past its retries asks for the next rung (#247) without a quality try.
            const timeoutRaise =
              ev.type === 'FailureClassified' &&
              ev.payload.class === 'timeout' &&
              ev.payload.rung !== null &&
              ev.payload.escalate;
            if (
              ev.type === 'FailureClassified' &&
              !countsTowardQuality(ev.payload.class) &&
              !timeoutRaise
            ) {
              expect(after.failure_streaks).toEqual(before?.failure_streaks);
              expect(ev.payload.escalate).toBe(false);
            }
            if (ev.type === 'FailureClassified' && timeoutRaise) {
              const k = streakKey(ev.payload.step, ev.payload.rung as number);
              expect(after.failure_streaks[k]?.escalate).toBe(true);
              expect(after.failure_streaks[k]?.quality_tries).toBe(
                before?.failure_streaks[k]?.quality_tries ?? 0,
              );
            }
          });
        }),
        propertyParams(150),
      );
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );
});
