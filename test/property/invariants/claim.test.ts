import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isBusinessEffect } from '../../../src/domain/effect.ts';
import {
  isTerminal,
  type EffectMirror,
  type TaskState,
} from '../../../src/domain/state.ts';
import { claimable } from '../../../src/engine/claim.ts';
import { choicesArb, drive } from '../arbitraries/signals.ts';
import {
  policyArb,
  propertyParams,
  taskOverArb,
} from '../arbitraries/policies.ts';

/** Independent claim-condition table in the documented reason-precedence order. */
function expected(s: TaskState, e: EffectMirror, now: number): string | null {
  if (!isBusinessEffect(e.kind)) return null;
  if (isTerminal(s.status)) return 'terminal';
  if (s.cancellation !== null) return 'cancelling';
  if (e.revision !== s.revision) return 'stale_revision';
  if (s.source_drift !== null) return 'source_drift';
  if (s.deadline_passed || (s.deadline_at !== null && now >= s.deadline_at))
    return 'deadline';
  if (s.status === 'WAITING' && s.wait?.detail['effect_id'] !== e.id)
    return 'task_waiting';
  return null;
}

describe('R-16 claim conditions', () => {
  it('blocks business effects by R-16 while allowing service effects and preserving pending state', () => {
    fc.assert(
      fc.property(
        policyArb,
        taskOverArb,
        choicesArb(),
        (policy, over, choices) => {
          const { trace } = drive(policy, over, choices);
          let blocked = 0;
          for (const t of trace) {
            const s = t.after;
            if (s === null) continue;
            for (const e of Object.values(s.effects)) {
              const c = claimable(s, e, t.now);
              const want = expected(s, e, t.now);
              expect(c).toEqual(
                want === null ? { ok: true } : { ok: false, reason: want },
              );
              if (!isBusinessEffect(e.kind)) expect(c.ok).toBe(true);
            }
            if (
              t.claim !== null &&
              !t.claim.ok &&
              t.claim.code === 'claim_blocked'
            ) {
              blocked++;

              if (t.decision === null) expect(t.after).toEqual(t.before);
            }
          }
          void blocked;
        },
      ),
      propertyParams(),
    );
  });
});
