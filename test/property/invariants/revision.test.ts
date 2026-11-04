import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isBusinessEffect } from '../../../src/domain/effect.ts';
import { compareLevel } from '../../../src/domain/policy.ts';
import { businessInFlight } from '../../../src/engine/effects.ts';
import { choicesArb, drive, eventsOf } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

describe('I08 decision-level revision immutability', () => {
  it('revision changes invalidate old evidence, approvals, and pending effects while preserving budgets, rungs, and deadlines', () => {
    let applied = 0;
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        // Frequent edits and forced revision choices ensure every run reaches RevisionApplied.
        const { trace } = drive(policy, over, choices, 1, {
          driftEvery: 3,
          driftFocus: true,
        });
        for (const t of trace) {
          if (!eventsOf(t).some((e) => e.type === 'RevisionApplied')) continue;
          applied++;
          const b = t.before!;
          const a = t.after!;
          expect(a.revision).toBe(b.revision + 1);
          expect(a.budget.agent_runs.used).toBe(b.budget.agent_runs.used);
          expect(a.budget.agent_runs.limit).toBe(b.budget.agent_runs.limit);
          expect(a.deadline_at).toBe(b.deadline_at);
          for (const [step, r] of Object.entries(b.rungs.by_step))
            expect(a.rungs.by_step[step] ?? 0).toBeGreaterThanOrEqual(r);
          if (b.rungs.floor_level !== null)
            expect(compareLevel(a.rungs.floor_level!, b.rungs.floor_level)).toBeGreaterThanOrEqual(
              0,
            );
          for (const e of Object.values(b.effects)) {
            if (e.status !== 'pending' || !isBusinessEffect(e.kind)) continue;
            expect(a.effects[e.id]?.status).toBe('invalidated');
            if (e.reservation_id !== null)
              expect(a.budget.reservations[e.reservation_id]?.status).toBe('released');
          }
          for (const ap of Object.values(a.approvals))
            if (ap.revision === b.revision) expect(ap.revoked).toBe(true);
          const ev = a.evidence;
          for (const list of [
            ev.gates,
            ev.reviews,
            ev.review_skipped,
            ev.ci,
            ev.base_relations,
            ev.publishes,
          ]) {
            for (const x of list) if (x.revision === b.revision) expect(x.valid).toBe(false);
          }
        }
      }),
      propertyParams(),
    );
    expect(applied).toBeGreaterThan(0);
  });

  it('source drift reaches a safe boundary once no business effects are running (FR-011)', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        const { trace } = drive(policy, over, choices, 1, { driftEvery: 3 });
        for (const t of trace) {
          const a = t.after;
          if (
            a === null ||
            a.source_drift === null ||
            a.cancellation !== null ||
            t.decision?.kind !== 'accepted'
          )
            continue;
          if (businessInFlight(a.effects).length === 0)
            expect(a.source_drift.safe_boundary_reached).toBe(true);
        }
      }),
      propertyParams(),
    );
  });
});
