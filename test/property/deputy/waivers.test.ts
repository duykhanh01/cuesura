import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FrozenPolicy } from '../../../src/domain/policy.ts';
import type { TaskState, Waiver } from '../../../src/domain/state.ts';
import { gateSignature, reviewScope } from '../../../src/engine/failure-signature.ts';
import { ciVerdict, mergeGuard } from '../../../src/engine/merge-guard.ts';
import {
  checkScope,
  gatesPass,
  reviewWaived,
  unlistedWaivers,
  waivedChecks,
  waiversSection,
} from '../../../src/engine/waivers.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, ownerAuthz } from '../../support/builders.ts';
import { createGrantStart, asUuid } from '../../support/runtime.ts';
import { agentData, expectAccepted, reviewData, started, toCode } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import {
  checkpointGates,
  completePost,
  currentReviewInput,
  publishToReview,
  toPublish,
} from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 T042 (FR-045, R-20): a waiver lets through exactly what it names, within its scope.

const waiver = (over: Partial<Waiver>): Waiver => ({
  id: 'w1',
  target: { kind: 'gate', key: 'unit' },
  scope: '',
  evidence: 'flaky',
  reason: 'known',
  by: 'deputy',
  turn_id: null,
  revision: 1,
  signature: 'S',
  at: 1,
  ...over,
});

const withWaivers = (waivers: Waiver[], over: Record<string, unknown> = {}): TaskState =>
  ({
    run: { waivers, pr_body: null },
    task: { base_branch: 'feature/x' },
    pr_ref: null,
    ...over,
  }) as unknown as TaskState;

const finding = (key: string) => ({ severity: 'major', file: `${key}.ts`, msg: key, key });

describe('review waivers', () => {
  it('approve only when every blocking finding is waived on the same key set', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('k1', 'k2', 'k3', 'k4'), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 4 }),
        (keys, waivedN) => {
          const review = { findings: keys.map(finding) };
          const scope = reviewScope(review);
          const waived = keys.slice(0, waivedN);
          const s = withWaivers(
            waived.map((k, i) =>
              waiver({ id: `w${i}`, target: { kind: 'finding', key: k }, scope }),
            ),
          );
          expect(reviewWaived(s, review)).toBe(waived.length === keys.length);
          // A review that blocks on another key set is not covered by these waivers.
          expect(reviewWaived(s, { findings: [...keys, 'k9'].map(finding) })).toBe(false);
        },
      ),
    );
    // Minor findings never block, so they need no waiver.
    const review = { findings: [finding('k1'), { severity: 'minor', msg: 'nit', key: 'n1' }] };
    const s = withWaivers([
      waiver({ target: { kind: 'finding', key: 'k1' }, scope: reviewScope(review) }),
    ]);
    expect(reviewWaived(s, review)).toBe(true);
  });
});

describe('gate waivers', () => {
  it('pass only on the failure the waiver names', () => {
    const log = 'src/a.ts:12:3 error: expected 1 to be 2';
    const s = withWaivers([waiver({ scope: gateSignature('unit', log) })]);
    const run = (excerpt: string) =>
      gatesPass(
        s,
        ['build', 'unit'],
        [
          { gate: 'build', passed: true },
          { gate: 'unit', passed: false, log_excerpt: excerpt },
        ],
      );
    expect(run('src/a.ts:40:9 error: expected 1 to be 2')).toEqual({
      passed: true,
      waived: ['unit'],
    });
    expect(run('src/a.ts:12:3 error: cannot read property x')).toEqual({
      passed: false,
      waived: [],
    });
    expect(
      gatesPass(
        s,
        ['build', 'unit'],
        [
          { gate: 'build', passed: false, log_excerpt: log },
          { gate: 'unit', passed: false, log_excerpt: log },
        ],
      ).passed,
    ).toBe(false);
  });

  it('a waived gate failure lets the engine go on and is recorded as waived', () => {
    const sim = started(buildTask());
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    const failing = {
      results: [
        { gate: 'build', passed: true },
        { gate: 'unit', passed: false, signature: 'u', log_excerpt: 'error: flaky timer' },
        { gate: 'lint', passed: true },
      ],
    };
    sim.complete(sim.pendingOne('run_gates').id, 'succeeded', failing);
    expect(sim.s.current_step).not.toBe('review');
    expectAccepted(
      sim.when({
        kind: 'waive',
        target: { kind: 'gate', key: 'unit' },
        evidence: 'timer flake #12',
      }),
    );
    expect(sim.s.run.waivers).toHaveLength(1);
    // The same failure again, after the fixer: it no longer blocks.
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
    sim.complete(sim.pendingOne('run_gates').id, 'succeeded', failing);
    const recorded = sim.events.findLast((e) => e.type === 'GateResultRecorded');
    expect(recorded?.payload).toMatchObject({
      passed: true,
      results: [{ gate: 'build' }, { gate: 'unit', passed: false, waived: true }, { gate: 'lint' }],
    });
    expect(sim.s.current_step).toBe('review');
    // Waiving it again on the same failure is refused.
    expect(
      sim.when({ kind: 'waive', target: { kind: 'gate', key: 'lint' }, evidence: 'x' }),
    ).toMatchObject({ kind: 'rejected', detail: { reason: 'waive_target_unknown' } });
    sim.replayCheck();
  });
});

describe('a waiver clears only the wait its own failure caused', () => {
  const failing = {
    results: [
      { gate: 'build', passed: true },
      { gate: 'unit', passed: false, signature: 'u', log_excerpt: 'error: flaky timer' },
      { gate: 'lint', passed: true },
    ],
  };
  const waive = {
    kind: 'waive' as const,
    target: { kind: 'gate' as const, key: 'unit' },
    evidence: 'x',
  };

  it('the gate loop ran out on that failure: the gates run again and let it through', () => {
    const sim = started(buildTask());
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    for (let i = 0; i < 40; i++) {
      const w = sim.s.wait;
      if (w?.detail.code === 'escalation') {
        const req = Object.values(sim.s.approvals).find((a) => a.status === 'requested');
        expectAccepted(sim.when({ kind: 'approve', approval_request_id: asUuid(req!.id) }));
        continue;
      }
      if (sim.s.status === 'WAITING') break;
      const gates = sim.effects('run_gates', 'pending')[0];
      if (gates !== undefined) sim.complete(gates.id, 'succeeded', failing);
      else sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
    }
    expect([
      'loop_exhausted',
      'ladder_exhausted',
      'rung_denied',
      'escalations_exhausted',
    ]).toContain(sim.s.wait?.detail.code);
    expectAccepted(sim.when(waive));
    expect(sim.s.status).not.toBe('WAITING');
    sim.complete(sim.pendingOne('run_gates').id, 'succeeded', failing);
    expect(sim.s.current_step).toBe('review');
    sim.replayCheck();
  });

  it('a wait of another cause (here the deadline) stays, though the failure is waived', () => {
    const sim = started(buildTask(), { policy: { limits: { max_wall_ms: 60_000 } } });
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(sim.pendingOne('run_gates').id, 'succeeded', failing);
    sim.advance(120_000).fireDue();
    const code = sim.s.wait?.detail.code;
    expect(code).toBe('deadline');
    expectAccepted(sim.when(waive));
    expect(sim.s.run.waivers).toHaveLength(1);
    expect(sim.s.status).toBe('WAITING');
    expect(sim.s.wait?.detail.code).toBe(code);
    sim.replayCheck();
  });
});

describe('check waivers', () => {
  const policy = (protectedBranches: string[]) =>
    ({
      ci: { required_checks: ['ci'], rules: [] },
      protected_branches: protectedBranches,
    }) as unknown as FrozenPolicy;
  const rs = { names: ['ci', 'lint'], source: 'branch_protection' as const, complete: true };
  const run = (o: { app?: number; run?: string } = {}) => ({
    name: 'ci',
    state: 'failure' as const,
    source: 'check_run' as const,
    app_id: o.app ?? 15368,
    run: o.run ?? '901',
  });
  const checks = [run(), { name: 'lint', state: 'success' as const }];

  it('hold only for the run, app and head they were given, never on a protected target', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('h1', 'h2'),
        fc.boolean(),
        fc.constantFrom('901', '902'),
        fc.constantFrom(15368, 777),
        (head, prot, id, app) => {
          const scope = checkScope('h1', run());
          const s = withWaivers([waiver({ target: { kind: 'check', key: 'ci' }, scope: scope! })]);
          const p = policy(prot ? ['feature/*'] : ['main']);
          const now = [run({ run: id, app }), checks[1]!];
          const same = head === 'h1' && id === '901' && app === 15368;
          expect(ciVerdict(p, rs, now, waivedChecks(s, p, head, now)).kind).toBe(
            same && !prot ? 'pass' : 'fail',
          );
        },
      ),
    );
    // A check read without its run cannot be scoped, so it cannot be waived.
    expect(checkScope('h1', { name: 'ci', state: 'failure' })).toBeNull();
  });

  it('the shared evaluation still needs a waived check to have run', () => {
    const p = policy(['main']);
    expect(ciVerdict(p, rs, [{ name: 'lint', state: 'success' }], new Set(['ci'])).kind).toBe(
      'incomplete',
    );
    expect(
      ciVerdict(
        p,
        rs,
        [...checks.slice(0, 1), { name: 'lint', state: 'failure' }],
        new Set(['ci']),
      ),
    ).toMatchObject({ kind: 'fail', failed: ['lint'] });
  });
});

describe('PR body and merge', () => {
  it('lists every waiver as waived and makes the merge wait until the body lists them', () => {
    const w = waiver({});
    expect(waiversSection([w])).toContain('**waived** gate `unit`');
    expect(waiversSection([w])).not.toMatch(/\bpassed\b/);
    const s = withWaivers([w], { pr_ref: 'acme#1' });
    expect(unlistedWaivers(s)).toEqual(['w1']);
    expect(
      unlistedWaivers(
        withWaivers([w], { pr_ref: 'acme#1', run: { waivers: [w], pr_body: { waivers: ['w1'] } } }),
      ),
    ).toEqual([]);
    expect(unlistedWaivers(withWaivers([w]))).toEqual([]);
  });
});

describe('review waiver through the engine', () => {
  const tempDir = useTempDir('cusr-waivers-');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  it('a rejection whose blocking findings are all waived routes as an approval', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    const reject = () =>
      reviewData('request_changes', d.task(t.id).run.checkpoint?.sha ?? A, {
        input_digest: currentReviewInput(d, t.id),
        findings: [
          { severity: 'major', file: 'a.ts', msg: 'no test', key: 'k1' },
          { severity: 'critical', file: 'b.ts', msg: 'race', key: 'k2' },
        ],
      });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', reject());
    completePost(d, t.id);
    expect(d.task(t.id).current_step).toBe('fix_review');
    for (const key of ['k1', 'k2'])
      d.must(
        t.id,
        { kind: 'waive', target: { kind: 'finding', key }, evidence: 'reviewer misreads the spec' },
        { authz: ownerAuthz() },
      );
    expect(d.task(t.id).run.waivers?.map((w) => w.target.key)).toEqual(['k1', 'k2']);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
    publishToReview(d, t.id, B);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', reject());
    const types = d.store.readEvents(asUuid(t.id)).map((e) => e.type);
    expect(types).toContain('ReviewWaived');
    expect(d.task(t.id).current_step).not.toBe('fix_review');
    // The approval stands as evidence of the head for the merge guard.
    expect(d.task(t.id).evidence.reviews.at(-1)).toMatchObject({ verdict: 'approve', head_sha: B });
    const s = d.task(t.id);
    const policy = d.store.readPolicy(asUuid(t.id), s.revision);
    if (policy === null) throw new Error('no policy');
    expect(mergeGuard(s, policy)).not.toMatchObject({ ok: false, code: 'review_missing' });
  });

  it('the review fix loop ran out: waiving the blocking findings approves the review', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    // More reviews than fixes: the fixer of the rejection is the step that runs out.
    createGrantStart(d, t, 'full-review', { limits: { extra_visits: { review: 10 } } });
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    let round = 0;
    const one = (kind: Parameters<StoreDriver['pending']>[1]) => d.pending(t.id, kind)[0];
    for (let i = 0; i < 200; i++) {
      const s = d.task(t.id);
      const code = s.wait?.detail.code;
      if (code === 'execution_slot') {
        d.grantNext();
        continue;
      }
      if (code === 'escalation') {
        const req = Object.values(s.approvals).find((a) => a.status === 'requested');
        d.must(
          t.id,
          { kind: 'approve', approval_request_id: asUuid(req!.id) },
          { authz: ownerAuthz() },
        );
        continue;
      }
      if (s.status === 'WAITING') break;
      const head = s.run.checkpoint?.sha ?? A;
      if (one('post_review') !== undefined) completePost(d, t.id);
      else if (one('run_gates') !== undefined)
        d.complete(
          t.id,
          one('run_gates')!.id,
          'succeeded',
          checkpointGates(round.toString(16).padStart(40, 'c')),
        );
      else if (one('publish') !== undefined) publishToReview(d, t.id, head);
      else if (s.current_step === 'review') {
        round++;
        d.complete(
          t.id,
          one('start_agent')!.id,
          'succeeded',
          reviewData('request_changes', head, {
            input_digest: currentReviewInput(d, t.id),
            findings: [{ severity: 'major', file: 'a.ts', msg: `gap ${round}`, key: `k${round}` }],
          }),
        );
      } else d.complete(t.id, one('start_agent')!.id, 'succeeded', agentData('done'));
    }
    const w = d.task(t.id).wait;
    expect(w?.detail).toMatchObject({ step: 'fix_review' });
    expect([
      'loop_exhausted',
      'ladder_exhausted',
      'rung_denied',
      'escalations_exhausted',
    ]).toContain(w?.detail.code);
    d.must(
      t.id,
      { kind: 'waive', target: { kind: 'finding', key: `k${round}` }, evidence: 'out of scope' },
      { authz: ownerAuthz() },
    );
    const s = d.task(t.id);
    expect(d.store.readEvents(asUuid(t.id)).map((e) => e.type)).toContain('ReviewWaived');
    expect(s.status).not.toBe('WAITING');
    // On the approve branch: the verdict is already on the PR, so it goes on to turn the PR ready.
    expect(['post_review', 'ready']).toContain(s.current_step);
  });
});
