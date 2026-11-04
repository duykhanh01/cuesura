import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import { choicesArb, drive } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

describe('I01 deterministic decisions', () => {
  it('identical inputs yield identical decisions without input mutations; replay matches', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        // Sim compares decisions on deeply frozen inputs and independent copies. Lint separately blocks clock and randomness access.

        const run = drive(policy, over, choices);

        run.sim.replayCheck();
      }),
      propertyParams(),
    );
  });

  it('the same choice sequence yields identical decisions and final state', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(40), (policy, over, choices) => {
        const a = drive(policy, over, choices);
        const b = drive(policy, over, choices);
        expect(canonicalJson(b.sim.decisions)).toBe(canonicalJson(a.sim.decisions));
        expect(canonicalJson(b.sim.state)).toBe(canonicalJson(a.sim.state));
      }),
      propertyParams(30),
    );
  });
});
