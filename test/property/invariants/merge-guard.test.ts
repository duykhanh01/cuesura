import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FrozenPolicy } from '../../../src/domain/policy.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { Check } from '../../../src/domain/trigger.ts';
import { mergeGuard } from '../../../src/engine/merge-guard.ts';
import { buildTask } from '../../support/builders.ts';
import {
  agentData,
  ciData,
  gatesData,
  publishData,
  reviewData,
  started,
  toCode,
} from '../../support/scenario.ts';
import { mergeAllowed } from '../../support/merge-oracle.ts';
import { choicesArb, drive, walk } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';
import { HEAVY_PROPERTY_TIMEOUT_MS } from '../../support/timeouts.ts';

describe('I11, FR-015 merge conditions', () => {
  it(
    'requires head-bound approval, approved review, successful checks, complete requirements, and base ancestry',
    () => {
      fc.assert(
        fc.property(policyArb, taskOverArb, choicesArb(160), (policy, over, choices) => {
          const { sim } = drive(policy, over, choices);
          let policyNow: FrozenPolicy | null = null;
          walk(sim.events, (before, ev) => {
            if (ev.type === 'PolicyFrozen' || ev.type === 'PolicyAmended')
              policyNow = ev.payload.policy;
            if (ev.type !== 'EffectRequested' || ev.payload.kind !== 'merge') return;
            const head = ev.payload.request['head_sha'] as string;
            expect(mergeAllowed(before!, policyNow!, head)).toBeNull();
          });
        }),
        propertyParams(150),
      );
      // Random sequences rarely reach merge; the focused property below guarantees merge cases.
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );
});

const stateArb = fc.constantFrom<Check['state']>(
  'success',
  'success',
  'success',
  'failure',
  'pending',
  'cancelled',
  'skipped',
  'unknown',
);
const ciArb = fc.record({
  head: fc.constantFrom('H', 'H', 'H', 'X'),
  checks: fc.dictionary(fc.constantFrom('A', 'B', 'C'), stateArb, {
    maxKeys: 3,
  }),
  names: fc.subarray(['A', 'B', 'C']),
  complete: fc.boolean(),
  base: fc.option(
    fc.record({
      head: fc.constantFrom('H', 'X'),
      ref: fc.constantFrom('main', 'main', 'other'),
      contains: fc.boolean(),
    }),
    { nil: undefined },
  ),
});

const mergeCaseArb = fc.record({
  required: fc.subarray(['A', 'B']),
  size: fc.constantFrom('M' as const, 'XS' as const),
  reviewHead: fc.constantFrom('H', 'H', 'X'),
  publishContains: fc.boolean(),
  cis: fc.array(ciArb, { minLength: 1, maxLength: 4 }),
  approveHead: fc.constantFrom('H', 'H', 'X'),
  cancel: fc.constantFrom('none', 'none', 'before', 'after'),
});

describe('I11 merge guard with generated evidence', () => {
  it(
    'every merge request satisfies the oracle; missing evidence causes a wait',
    () => {
      let merges = 0;
      let blocked = 0;
      fc.assert(
        fc.property(mergeCaseArb, (m) => {
          const sim = started(buildTask({ size: m.size }), {
            policy: { required_checks: m.required },
          });
          sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
          sim.complete(
            sim.pendingOne('run_gates').id,
            'succeeded',
            gatesData({ build: true, unit: true }),
          );
          if (m.size !== 'XS')
            sim.complete(
              sim.pendingOne('start_agent').id,
              'succeeded',
              reviewData('approve', m.reviewHead),
            );
          sim.complete(
            sim.pendingOne('publish').id,
            'succeeded',
            publishData('H', m.publishContains),
          );
          sim.complete(sim.pendingOne('create_pr').id, 'succeeded', {
            pr_ref: 'acme#1',
            head_sha: 'H',
          });
          for (const ci of m.cis) {
            const pending = sim.effects('await_ci', 'pending')[0];
            if (pending === undefined) {
              const t = sim.armedTimers('ci_poll')[0];
              if (t === undefined) break;
              sim.now = Math.max(sim.now, t.due_at);
              sim.fire(t.id);
            }
            const e = sim.effects('await_ci', 'pending')[0];
            if (e === undefined) break;
            const extra =
              ci.base === undefined
                ? {}
                : {
                    base_relation: {
                      head_sha: ci.base.head,
                      base_ref: ci.base.ref,
                      base_sha: 'b9',
                      head_contains_base: ci.base.contains,
                    },
                  };
            sim.complete(
              e.id,
              'succeeded',
              ciData(ci.head, ci.checks, { names: ci.names, complete: ci.complete }, extra),
            );
          }
          const approval = Object.values(sim.s.approvals).find((a) => a.status === 'requested');
          if (approval !== undefined) {
            if (m.cancel === 'before') sim.when({ kind: 'cancel', reason: 'x' });
            sim.when({
              kind: 'approve',
              approval_request_id: approval.id as Uuid,
              head_sha: m.approveHead,
            });
            if (m.cancel === 'after') sim.when({ kind: 'cancel', reason: 'x' });
          }
          let policyNow: FrozenPolicy | null = null;
          walk(sim.events, (before, ev, after) => {
            if (ev.type === 'PolicyFrozen') policyNow = ev.payload.policy;

            if (policyNow !== null && after.head_sha !== null) {
              expect(mergeGuard(after, policyNow).ok).toBe(
                mergeAllowed(after, policyNow, after.head_sha) === null,
              );
            }
            if (ev.type !== 'EffectRequested' || ev.payload.kind !== 'merge') return;
            merges++;
            expect(
              mergeAllowed(before!, policyNow!, ev.payload.request['head_sha'] as string),
            ).toBeNull();
          });
          if (sim.effects('merge').length === 0 && sim.s.cancellation === null) {
            blocked++;
            // A failed check no rule classifies goes to the CI fixer instead of a wait (#246).
            if (sim.s.current_step === 'ci_fix') expect(sim.s.status).toBe('RUNNING');
            else expect(sim.s.status).toBe('WAITING');
          }
        }),
        propertyParams(300),
      );
      expect(merges).toBeGreaterThan(0);
      expect(blocked).toBeGreaterThan(0);
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );
});
