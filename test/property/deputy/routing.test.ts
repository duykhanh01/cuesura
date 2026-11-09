import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DETAIL_CODES, type DetailCode } from '../../../src/domain/state.ts';
import { DEPUTY_ROUTE, routeOf } from '../../../src/engine/deputy-routing.ts';
import {
  CANCEL_READS_BEFORE_ATTENTION,
  EFFECT_UNKNOWN_ATTENTION_MS,
  NEEDS_USER,
} from '../../../src/explain/needs-user.ts';
import { waitingOn } from '../../support/deputy.ts';

// 007 FR-001, R-02: every wait code goes to exactly one place.

const PENDING_CODES: readonly DetailCode[] = [
  'missing_acceptance',
  'needs_confirmation',
  'dependency_pending',
  'dependency_failed',
  'config_invalid',
  'unsupported_workflow',
  'unsupported_decision_mode',
  'no_valid_binding',
  'override_exceeds_caller',
  'adopt_approval',
];
const OWNER_CODES: readonly DetailCode[] = [
  'run_config_unconfirmed',
  'paused',
  'escalation_rejected',
  'adopt_approval',
  'merge',
  'auth_config',
  'harness_auth',
  'refused',
  'plan_amendment',
];
const WORKER_QUESTIONS: readonly DetailCode[] = [
  'agent_question',
  'agent_needs_context',
  'agent_blocked',
];

/** FR-001 as written, independent of the table. */
function expected(code: DetailCode, autonomous: boolean): 'deputy' | 'owner' | null {
  if (!NEEDS_USER[code]) return null;
  if (PENDING_CODES.includes(code) || OWNER_CODES.includes(code)) return 'owner';
  if (WORKER_QUESTIONS.includes(code)) return autonomous ? 'deputy' : 'owner';
  return 'deputy';
}

const codeArb = fc.constantFrom(...DETAIL_CODES);

describe('deputy routing table', () => {
  it('routes every code once, and auto is exactly what needs no person', () => {
    expect(Object.keys(DEPUTY_ROUTE).sort()).toEqual([...DETAIL_CODES].sort());
    for (const code of DETAIL_CODES)
      expect({ code, auto: DEPUTY_ROUTE[code] === 'auto' }).toEqual({
        code,
        auto: !NEEDS_USER[code],
      });
  });

  it('matches FR-001 for every code, flag and time', () => {
    fc.assert(
      fc.property(codeArb, fc.boolean(), fc.nat(), (code, autonomous, now) => {
        // `since` far in the future keeps an effect_unknown wait under its threshold.
        const s = waitingOn(code, { since: now + 1 });
        expect(routeOf(s, autonomous, now)).toBe(expected(code, autonomous));
      }),
    );
  });

  it('sends an effect_unknown wait to the deputy only past its threshold', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1e12 }),
        fc.integer({ min: 0, max: 2 * EFFECT_UNKNOWN_ATTENTION_MS }),
        (since, after) => {
          const s = waitingOn('effect_unknown', { since });
          expect(routeOf(s, true, since + after)).toBe(
            after >= EFFECT_UNKNOWN_ATTENTION_MS ? 'deputy' : null,
          );
        },
      ),
    );
  });

  it('keeps a boundary violation and a stuck cancel with the owner', () => {
    expect(routeOf(waitingOn('effect_failed'), true, 0)).toBe('deputy');
    expect(routeOf(waitingOn('effect_failed', { failure: 'boundary_violation' }), true, 0)).toBe(
      'owner',
    );
    expect(routeOf(waitingOn('cancel_reconcile', { cancel_reads: 1 }), true, 0)).toBeNull();
    expect(
      routeOf(
        waitingOn('cancel_reconcile', { cancel_reads: CANCEL_READS_BEFORE_ATTENTION }),
        true,
        0,
      ),
    ).toBe('owner');
  });

  it('routes nothing for an ended task', () => {
    fc.assert(
      fc.property(codeArb, fc.constantFrom('DONE', 'FAILED', 'CANCELLED'), (code, status) => {
        expect(routeOf({ ...waitingOn(code), status }, true, 0)).toBeNull();
      }),
    );
  });
});
