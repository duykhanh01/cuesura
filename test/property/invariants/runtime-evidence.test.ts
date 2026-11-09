import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { claimable } from '../../../src/engine/claim.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, publishData, reviewData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { checkpointGates, currentReviewInput } from '../../support/store-flows.ts';
import { HEAVY_PROPERTY_TIMEOUT_MS } from '../../support/timeouts.ts';
import { propertyParams } from '../arbitraries/policies.ts';

// Review evidence in `full-review` (T050, FR-014, M03/M06, FR-041.03, H01/H02). Whatever the worker does
// between reviews, a reviewer runs exactly once per distinct review input (commit + PR content) of the
// revision; an unchanged input reuses the verdict without a reviewer run or usage; every recorded verdict
// is bound to the checkpoint it was given; the PR turns ready only for the published checkpoint the last
// approval is for. A remote head drift, wherever it lands, stops every business effect, an enqueued
// publish included, and a late approval never reopens publish, a posted review or a ready PR.

type Change = 'commit' | 'content' | 'none';
type Round = { change: Change; verdict: 'approve' | 'request_changes' };

const roundArb: fc.Arbitrary<Round> = fc.record({
  change: fc.constantFrom<Change>('commit', 'content', 'none'),
  verdict: fc.constantFrom<'approve' | 'request_changes'>(
    'approve',
    'request_changes',
    'request_changes',
  ),
});

const sha = (n: number) => n.toString(16).padStart(40, '0');
const FINDINGS = [{ severity: 'major', msg: 'handle the empty query' }];

type Run = {
  d: StoreDriver;
  t: CanonicalTask;
  reviewerRuns: number;
  inputs: Set<string>;
  drifted: boolean;
  /** Effects that existed when the drift was recorded. */
  beforeDrift: Set<string>;
};

/** Drives the task by its pending effects; `rounds` scripts the worker and reviewer. Returns when nothing is pending. */
function drive(rounds: readonly Round[], driftAt: number | null): Run {
  const d = new StoreDriver(openMemoryStore());
  const t = buildTask();
  createGrantStart(d, t, 'full-review', { limits: { max_agent_runs: 60 } });
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
    base_sha: 'base0000',
    worktree_ref: 'wt',
    branch: 'b',
    setup: { ran: false, passed: true },
  });
  const run: Run = {
    d,
    t,
    reviewerRuns: 0,
    inputs: new Set(),
    drifted: false,
    beforeDrift: new Set(),
  };
  let commit = 1;
  let content = 0;
  let round = 0;
  let pendingChange: Change = 'commit';
  for (let step = 0; step < 200; step++) {
    if (driftAt !== null && step === driftAt && !run.drifted) {
      d.must(t.id, {
        kind: 'head_drift',
        expected: sha(commit),
        observed: 'f'.repeat(40),
        source: 'observation',
        evidence_ref: 'obs:drift',
      });
      run.drifted = true;
      run.beforeDrift = new Set(Object.keys(d.task(t.id).effects));
    }
    // The PR step holds no slot: the review queues for it again.
    if (!run.drifted && d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    const s = d.task(t.id);
    const pending = d.pending(t.id).filter(
      (e) =>
        claimable(s, { id: e.id, kind: e.kind, revision: e.revision }, d.now, {
          require_runtime: true,
        }).ok,
    );
    const e = pending[0];
    if (e === undefined) return run;
    const mirror = s.effects[e.id];
    if (e.kind === 'mark_ready') return run;
    if (e.kind === 'publish') {
      d.complete(t.id, e.id, 'succeeded', publishData(String(e.request['sha'])));
      continue;
    }
    if (e.kind === 'create_pr') {
      d.complete(t.id, e.id, 'succeeded', {
        pr_ref: 'acme#7',
        head_sha: s.head_sha ?? '',
      });
      continue;
    }
    if (e.kind === 'post_review') {
      d.complete(t.id, e.id, 'succeeded', {
        attempt_id: e.request['attempt_id'],
        outcome: 'posted',
        review_id: 1,
        inline: 0,
        detail: null,
      });
      continue;
    }
    if (e.kind === 'start_agent' && mirror?.step === 'review') {
      run.reviewerRuns++;
      const input = currentReviewInput(d, t.id);
      run.inputs.add(input);
      const r = rounds[round] ?? { change: 'none', verdict: 'approve' };
      round++;
      pendingChange = r.change;
      const cp = s.run.checkpoint?.sha ?? '';
      d.complete(
        t.id,
        e.id,
        'succeeded',
        reviewData(r.verdict, cp, {
          input_digest: input,
          ...(r.verdict === 'request_changes' ? { findings: FINDINGS } : {}),
        }),
      );
      continue;
    }
    if (e.kind === 'start_agent') {
      if (pendingChange === 'content') content++;
      d.complete(
        t.id,
        e.id,
        'succeeded',
        agentData(
          'done',
          pendingChange === 'content' || content === 0
            ? {
                content: {
                  digest: hashCanonical(`c${content}`),
                  ref: `/c/${content}.json`,
                },
              }
            : {},
        ),
      );
      continue;
    }
    if (e.kind === 'run_gates') {
      const changed = pendingChange === 'commit';
      if (changed) commit++;
      const base = checkpointGates(sha(commit));
      d.complete(t.id, e.id, 'succeeded', {
        ...base,
        checkpoint: {
          ...(base['checkpoint'] as object),
          content_digest: hashCanonical(`c${content}`),
          committed: changed,
        },
      });
      pendingChange = 'none';
      continue;
    }
    throw new Error(`unexpected effect ${e.kind}`);
  }
  throw new Error('drive did not settle');
}

describe('review evidence (T050, FR-014, M03)', () => {
  it(
    'one reviewer run per distinct input; verdicts bound to their checkpoint; only the approved published checkpoint turns the PR ready',
    () => {
      fc.assert(
        fc.property(fc.array(roundArb, { minLength: 1, maxLength: 8 }), (rounds) => {
          const { d, t, reviewerRuns, inputs } = drive(rounds, null);
          const s = d.task(t.id);
          expect(reviewerRuns).toBe(inputs.size);
          const ran = Object.values(s.effects).filter(
            (e) => e.kind === 'start_agent' && e.step === 'review',
          ).length;
          expect(ran).toBe(reviewerRuns);
          // Reused verdicts are free: usage only for reviewer runs that happened.
          const reused = d.store.readEvents(t.id).filter((e) => e.type === 'ReviewReused');
          for (const r of reused)
            expect(inputs.has((r.payload as { input_digest: string }).input_digest)).toBe(true);
          for (const r of s.run.reviews) expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
          const ready = d.pending(t.id, 'mark_ready')[0];
          if (ready !== undefined) {
            const cp = s.run.checkpoint;
            expect(s.head_sha).toBe(cp?.sha);
            const last = s.run.reviews.filter((r) => r.valid && r.sha === cp?.sha).at(-1);
            expect(last?.verdict).toBe('approve');
          }
        }),
        propertyParams(40),
      );
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );

  it(
    'H01/H02: a head drift at any point blocks every business effect; nothing publishes, posts or turns ready after it',
    () => {
      fc.assert(
        fc.property(
          fc.array(roundArb, { minLength: 1, maxLength: 5 }),
          fc.integer({ min: 0, max: 12 }),
          (rounds, at) => {
            const { d, t, drifted, beforeDrift } = drive(rounds, at);
            if (!drifted) return;
            const s = d.task(t.id);
            expect(s.run.head_drift).not.toBeNull();
            expect(s.blockers.map((b) => b.code)).toContain('head_changed');
            for (const e of d.pending(t.id)) {
              const c = claimable(s, { id: e.id, kind: e.kind, revision: e.revision }, d.now, {
                require_runtime: true,
              });
              if (
                e.kind !== 'stop_attempt' &&
                e.kind !== 'reconcile' &&
                e.kind !== 'observe_external'
              )
                expect(c).toEqual({ ok: false, reason: 'head_changed' });
            }
            expect(
              Object.values(s.effects).filter(
                (e) =>
                  !beforeDrift.has(e.id) &&
                  ['publish', 'create_pr', 'post_review', 'mark_ready'].includes(e.kind) &&
                  e.status !== 'invalidated' &&
                  e.status !== 'pending',
              ),
            ).toEqual([]);
          },
        ),
        propertyParams(40),
      );
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );
});

describe('T139 M04 context admission', () => {
  it('a pre-launch needs_context never spends usage or automatically retries in either mode', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('direct-pr', 'full-review'),
        fc.string({ minLength: 1, maxLength: 100 }),
        (mode, summary) => {
          const d = new StoreDriver(openMemoryStore());
          const t = buildTask();
          try {
            createGrantStart(d, t, mode);
            d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
              base_sha: 'base0000',
              worktree_ref: 'wt',
              branch: 'b',
              setup: { ran: false, passed: true },
            });
            d.complete(
              t.id,
              d.pendingOne(t.id, 'start_agent').id,
              'succeeded',
              agentData('needs_context', { summary, invoked: false }),
            );
            expect(d.task(t.id).status).toBe('WAITING');
            expect(d.task(t.id).wait?.reason).toBe('human_input');
            expect(d.pending(t.id, 'start_agent')).toEqual([]);
            expect(d.task(t.id).budget.agent_runs).toMatchObject({
              used: 0,
              reserved: 0,
            });
            expect(d.store.readEvents(t.id).filter((e) => e.type === 'BudgetConsumed')).toEqual([]);
          } finally {
            d.store.close();
          }
        },
      ),
      propertyParams(30),
    );
  });
});
