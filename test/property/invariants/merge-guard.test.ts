import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FrozenPolicy } from '../../../src/domain/policy.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { Check } from '../../../src/domain/trigger.ts';
import { mergeGuard } from '../../../src/engine/merge-guard.ts';
import { buildTask } from '../../support/builders.ts';
import { agentData, ciData, gatesData, publishData, reviewData, started, toCode } from '../../support/scenario.ts';
import { choicesArb, drive, walk } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

/** Oracle độc lập với `src/engine/merge-guard.ts`, viết thẳng từ FR-015 và research R-10. */
function mergeAllowed(s: TaskState, p: FrozenPolicy, head: string): string | null {
  if (s.cancellation !== null) return 'đang hủy';
  if (s.head_sha !== head) return 'head khác head hiện hành';
  const rev = s.revision;
  const approval = Object.values(s.approvals).some((a) => a.kind === 'merge' && a.status === 'granted' && !a.revoked && a.revision === rev && a.head_sha === head);
  if (!approval) return 'thiếu approval merge gắn head';
  const reviews = s.evidence.reviews.filter((r) => r.valid && r.revision === rev && r.head_sha === head);
  const skipped = s.evidence.review_skipped.some((r) => r.valid && r.revision === rev);
  if (reviews.at(-1)?.verdict !== 'approve' && !skipped) return 'thiếu review approve cho head';
  const ci = s.evidence.ci.filter((c) => c.valid && c.revision === rev && c.head_sha === head).at(-1);
  if (ci === undefined) return 'thiếu CI cho head';
  if (!ci.required_set.complete) return 'required_set chưa đầy đủ';
  const expected = new Set([...p.ci.required_checks, ...ci.required_set.names]);
  for (const name of expected) {
    if (ci.checks.find((c) => c.name === name)?.state !== 'success') return `check ${name} chưa success`;
  }
  const base = s.evidence.base_relations.filter((b) => b.valid && b.revision === rev && b.head_sha === head && b.base_ref === s.task.base_branch).at(-1);
  if (base?.head_contains_base !== true) return 'head chưa chứa base';
  return null;
}

describe('I11, FR-015 điều kiện merge', () => {
  it('không EffectRequested(merge) khi thiếu approval gắn head, review approve, required check success, required_set.complete hoặc head_contains_base', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(160), (policy, over, choices) => {
        const { sim } = drive(policy, over, choices);
        let policyNow: FrozenPolicy | null = null;
        walk(sim.events, (before, ev) => {
          if (ev.type === 'PolicyFrozen' || ev.type === 'PolicyAmended') policyNow = ev.payload.policy;
          if (ev.type !== 'EffectRequested' || ev.payload.kind !== 'merge') return;
          const head = ev.payload.request['head_sha'] as string;
          expect(mergeAllowed(before!, policyNow!, head)).toBeNull();
        });
      }),
      propertyParams(150),
    );
    // Chuỗi ngẫu nhiên hiếm khi tới merge; property tập trung bên dưới bảo đảm luôn có ca merge.
  });
});

const stateArb = fc.constantFrom<Check['state']>('success', 'success', 'success', 'failure', 'pending', 'cancelled', 'skipped', 'unknown');
const ciArb = fc.record({
  head: fc.constantFrom('H', 'H', 'H', 'X'),
  checks: fc.dictionary(fc.constantFrom('A', 'B', 'C'), stateArb, { maxKeys: 3 }),
  names: fc.subarray(['A', 'B', 'C']),
  complete: fc.boolean(),
  base: fc.option(fc.record({ head: fc.constantFrom('H', 'X'), ref: fc.constantFrom('main', 'main', 'other'), contains: fc.boolean() }), { nil: undefined }),
});

/** Bằng chứng ngẫu nhiên ngay trước bước merge: head review/publish/approval, CI nhiều lượt, quan hệ base. */
const mergeCaseArb = fc.record({
  required: fc.subarray(['A', 'B']),
  size: fc.constantFrom('M' as const, 'XS' as const),
  reviewHead: fc.constantFrom('H', 'H', 'X'),
  publishContains: fc.boolean(),
  cis: fc.array(ciArb, { minLength: 1, maxLength: 4 }),
  approveHead: fc.constantFrom('H', 'H', 'X'),
  cancel: fc.constantFrom('none', 'none', 'before', 'after'),
});

describe('I11 merge guard trên bằng chứng sinh ngẫu nhiên', () => {
  it('mọi EffectRequested(merge) thoả oracle; bằng chứng thiếu thì task chờ thay vì merge', () => {
    let merges = 0;
    let blocked = 0;
    fc.assert(
      fc.property(mergeCaseArb, (m) => {
        const sim = started(buildTask({ size: m.size }), { policy: { required_checks: m.required } });
        sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
        sim.complete(sim.pendingOne('run_gates').id, 'succeeded', gatesData({ build: true, unit: true }));
        if (m.size !== 'XS') sim.complete(sim.pendingOne('start_agent').id, 'succeeded', reviewData('approve', m.reviewHead));
        sim.complete(sim.pendingOne('publish').id, 'succeeded', publishData('H', m.publishContains));
        sim.complete(sim.pendingOne('create_pr').id, 'succeeded', { pr_ref: 'acme#1', head_sha: 'H' });
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
          const extra = ci.base === undefined ? {} : { base_relation: { head_sha: ci.base.head, base_ref: ci.base.ref, base_sha: 'b9', head_contains_base: ci.base.contains } };
          sim.complete(e.id, 'succeeded', ciData(ci.head, ci.checks, { names: ci.names, complete: ci.complete }, extra));
        }
        const approval = Object.values(sim.s.approvals).find((a) => a.status === 'requested');
        if (approval !== undefined) {
          if (m.cancel === 'before') sim.when({ kind: 'cancel', reason: 'x' });
          sim.when({ kind: 'approve', approval_request_id: approval.id as Uuid, head_sha: m.approveHead });
          if (m.cancel === 'after') sim.when({ kind: 'cancel', reason: 'x' });
        }
        let policyNow: FrozenPolicy | null = null;
        walk(sim.events, (before, ev, after) => {
          if (ev.type === 'PolicyFrozen') policyNow = ev.payload.policy;
          // Chính hàm guard (lớp phòng thủ thứ hai sau bước approval) khớp oracle trên mọi state.
          if (policyNow !== null && after.head_sha !== null) {
            expect(mergeGuard(after, policyNow).ok).toBe(mergeAllowed(after, policyNow, after.head_sha) === null);
          }
          if (ev.type !== 'EffectRequested' || ev.payload.kind !== 'merge') return;
          merges++;
          expect(mergeAllowed(before!, policyNow!, ev.payload.request['head_sha'] as string)).toBeNull();
        });
        if (sim.effects('merge').length === 0 && sim.s.cancellation === null) {
          blocked++;
          expect(sim.s.status).toBe('WAITING');
        }
      }),
      propertyParams(300),
    );
    expect(merges).toBeGreaterThan(0);
    expect(blocked).toBeGreaterThan(0);
  });
});
