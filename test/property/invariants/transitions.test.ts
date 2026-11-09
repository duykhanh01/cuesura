import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isTerminal, PENDING_REASONS, WAITING_REASONS } from '../../../src/domain/state.ts';
import { isAllowedEdge, POST_TERMINAL_EVENTS } from '../../../src/engine/evolve.ts';
import { choicesArb, drive, eventsOf, walk } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

describe('FR-009, I12 state transitions', () => {
  it('permits only valid transitions, preserves terminal states, and explains every wait (SC-006)', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        const { sim, trace } = drive(policy, over, choices);
        walk(sim.events, (before, ev, after) => {
          if (before !== null && before.status !== after.status) {
            expect(
              isAllowedEdge(before.status, after.status),
              `${ev.type}: ${before.status} → ${after.status}`,
            ).toBe(true);
          }
          if (before !== null && isTerminal(before.status)) {
            expect(POST_TERMINAL_EVENTS).toContain(ev.type);
            expect(after.status).toBe(before.status);
          }
          if (after.status === 'WAITING') {
            expect(WAITING_REASONS).toContain(after.wait?.reason);
          }
          if (after.status === 'PENDING' && after.wait !== null) {
            expect(PENDING_REASONS).toContain(after.wait.reason);
          }
          if (after.status === 'WAITING' || (after.status === 'PENDING' && after.wait !== null)) {
            expect(after.wait?.resume_when.length ?? 0).toBeGreaterThan(0);
            expect(after.wait?.exit_paths.length ?? 0).toBeGreaterThan(0);
          }
          if (isTerminal(after.status)) expect(after.terminal?.kind).toBe(after.status);
        });

        let ended = false;
        for (const t of trace) {
          if (ended && t.decision?.kind === 'accepted') {
            expect(eventsOf(t).every((e) => POST_TERMINAL_EVENTS.includes(e.type))).toBe(true);
          }
          if (t.after !== null && isTerminal(t.after.status)) ended = true;
        }
      }),
      propertyParams(),
    );
  });
});
