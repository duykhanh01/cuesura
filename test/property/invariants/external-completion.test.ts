import { emptyRuntime } from '../../../src/engine/evolve.ts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { notifyDependents } from '../../../src/application/dependency.ts';
import { isBusinessEffect } from '../../../src/domain/effect.ts';
import type { MergeProof } from '../../../src/domain/runtime.ts';
import type { ExecutionMode } from '../../../src/domain/run-config.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { Check } from '../../../src/domain/trigger.ts';
import { drainPending } from '../../../src/engine/drain.ts';
import { headVerdict } from '../../../src/engine/head-evidence.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { ciData, publishData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { toPublish, reviewToCi } from '../../support/store-flows.ts';
import { propertyParams } from '../arbitraries/policies.ts';

// FR-040.01–15 and FR-001.02/03: a merge proof ends business work, TaskCompleted happens at most once and
// only with nothing pending, a terminal task is never reopened, and a dependent is released only by DONE.

const HEAD = 'a'.repeat(40);
const proof: MergeProof = {
  subject: {
    provider: 'github',
    immutable_repo_id: 'R1',
    subject_id: '700',
    target_ref: 'main',
    head_ref: 'cusr/t',
  },
  merged_at: 1,
  merged_head_sha: HEAD,
  checked_head_sha: null,
  merge_commit_sha: 'c'.repeat(40),
  observation_id: 'obs-1',
  evidence_ref: 'ev-1',
};

function toCi(d: StoreDriver, t: CanonicalTask, mode: ExecutionMode = 'full-review'): void {
  createGrantStart(d, t, mode);
  toPublish(d, t, HEAD);
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(HEAD));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: HEAD,
  });
  reviewToCi(d, t.id);
}

function observeMerged(d: StoreDriver, t: CanonicalTask): void {
  d.send(t.id, {
    kind: 'observation_result',
    observation: {
      observation_id: 'obs-1',
      source: 'timer',
      requested_at: d.now,
      observed_at: d.now,
      generation: 1,
      subject: proof.subject,
      status: 'merged',
      observed_head: HEAD,
      raw_evidence_ref: 'ev-1',
      completeness: { merge_proof: true, quality: false },
    },
    remote_digest: `sha256:${'d'.repeat(64)}`,
  });
}

type Step = 'merge' | 'drain' | 'cancel' | 'ci_result' | 'ci_unknown' | 'tick';
const stepArb = fc.array(
  fc.constantFrom<Step>('merge', 'drain', 'cancel', 'ci_result', 'ci_unknown', 'tick'),
  { minLength: 1, maxLength: 10 },
);

describe('external completion (FR-040, FR-001.02/03)', () => {
  it('completes at most once, only with nothing pending, never reopens and never starts business work after the proof', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ExecutionMode>('direct-pr', 'full-review'),
        fc.boolean(),
        stepArb,
        (mode, inFlight, steps) => {
          const d = new StoreDriver(openMemoryStore());
          const t = buildTask();
          toCi(d, t, mode);
          const ci = d.pendingOne(t.id, 'await_ci');
          if (inFlight) d.claim(ci.id);
          else
            d.complete(
              t.id,
              ci.id,
              'succeeded',
              ciData(HEAD, { build: 'success', test: 'success' }),
            );
          let merged = false;
          for (const s of steps) {
            d.now += 61_000;
            const before = d.task(t.id);
            switch (s) {
              case 'merge':
                observeMerged(d, t);
                d.send(t.id, {
                  kind: 'external_completion',
                  proof,
                  unverified_reason: null,
                });
                merged = merged || d.task(t.id).completion !== null;
                break;
              case 'drain':
                d.send(t.id, { kind: 'drain_result', pending_operations: [] });
                break;
              case 'cancel':
                d.send(t.id, { kind: 'cancel', reason: 'property' });
                break;
              case 'ci_result':
                if (d.task(t.id).effects[ci.id]?.status === 'started')
                  d.send(t.id, {
                    kind: 'effect_result',
                    effect_id: ci.id as Uuid,
                    outcome: 'succeeded',
                    data: ciData(HEAD, { build: 'failure', test: 'success' }),
                  });
                break;
              case 'ci_unknown':
                if (d.task(t.id).effects[ci.id]?.status === 'started')
                  d.send(t.id, {
                    kind: 'effect_result',
                    effect_id: ci.id as Uuid,
                    outcome: 'unknown',
                  });
                break;
              case 'tick':
                d.fire();
                break;
            }
            const after = d.task(t.id);
            const events = d.store.readEvents(t.id).map((e) => e.type);
            // At most one TaskCompleted, ever.
            expect(events.filter((e) => e === 'TaskCompleted').length).toBeLessThanOrEqual(1);
            // Terminal states stay terminal.
            if (['DONE', 'FAILED', 'CANCELLED'].includes(before.status))
              expect(after.status).toBe(before.status);
            if (after.completion !== null) {
              // A recorded merge never ends CANCELLED, and DONE only with nothing pending.
              expect(after.status).not.toBe('CANCELLED');
              if (after.status === 'DONE') expect(drainPending(after)).toEqual([]);
              if (after.status !== 'DONE') expect(after.completion.finalized_at).toBeNull();
              // No business effect waits to be claimed after the proof.
              expect(
                Object.values(after.effects).filter(
                  (e) => e.status === 'pending' && isBusinessEffect(e.kind),
                ),
              ).toEqual([]);
            }
          }
          if (merged && !inFlight) expect(d.task(t.id).status).toBe('DONE');
          // The checked checkpoint merged with green CI is verified in either mode; a direct-pr task never
          // carries a review it did not have.
          if (mode === 'direct-pr')
            expect(d.store.readEvents(t.id).map((e) => e.type)).not.toContain(
              'ReviewVerdictRecorded',
            );
        },
      ),
      propertyParams(25),
    );
  });

  it('a dependent is released only after its prerequisite recorded DONE', () => {
    fc.assert(
      fc.property(fc.constantFrom('done', 'draining', 'cancelled', 'running'), (fate) => {
        const d = new StoreDriver(openMemoryStore());
        const pre = buildTask();
        toCi(d, pre);
        const child = buildTask({
          id: uuidOf(2),
          source_key: 'cli:2',
          depends_on: [pre.id],
        });
        d.must(child.id, { kind: 'create_task', task: child });
        const ci = d.pendingOne(pre.id, 'await_ci');
        if (fate === 'done' || fate === 'draining') {
          if (fate === 'draining') d.claim(ci.id);
          else
            d.complete(
              pre.id,
              ci.id,
              'succeeded',
              ciData(HEAD, { build: 'success', test: 'success' }),
            );
          observeMerged(d, pre);
          d.must(pre.id, {
            kind: 'external_completion',
            proof,
            unverified_reason: null,
          });
        }
        if (fate === 'cancelled') d.must(pre.id, { kind: 'cancel', reason: 'dropped' });
        notifyDependents(d.store, d.now);
        const status = d.task(child.id).status;
        expect(status === 'READY').toBe(d.task(pre.id).status === 'DONE');
        if (fate === 'draining') expect(d.task(pre.id).completion).not.toBeNull();
      }),
      propertyParams(12),
    );
  });
});

const STATES: readonly Check['state'][] = [
  'success',
  'failure',
  'pending',
  'cancelled',
  'skipped',
  'unknown',
];

describe('green predicate on the checked head (FR-019, FR-041.06, FR-042.08, M08)', () => {
  it('green iff every snapshot check is a single success (or skipped with no failed or cancelled check) on that head with covered requirements, complete reads, the gate on that checkpoint and the review its mode requires', () => {
    const names = ['build', 'test', 'lint'];
    fc.assert(
      fc.property(
        fc.constantFrom<ExecutionMode | null>(null, 'direct-pr', 'full-review'),
        fc.subarray(names, { minLength: 1 }),
        fc.array(
          fc.record({
            name: fc.constantFrom(...names),
            state: fc.constantFrom(...STATES),
          }),
          { maxLength: 6 },
        ),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom<'approve' | 'request_changes' | 'none'>(
          'approve',
          'request_changes',
          'none',
        ),
        fc.boolean(),
        fc.boolean(),
        (mode, snapshot, checks, covered, complete, gatePassed, review, sameHead, onCheckpoint) => {
          const head = 'a'.repeat(40);
          const cpSha = onCheckpoint ? head : 'c'.repeat(40);
          const run = {
            ...emptyRuntime().run,
            mode,
            checkpoint:
              mode === null
                ? null
                : {
                    revision: 1,
                    sha: cpSha,
                    tree: 'e'.repeat(40),
                    base_sha: 'base',
                    diff_digest: 'd',
                    content_digest: 'x',
                    committed: true,
                    gate_visit: 1,
                  },
            reviews:
              review === 'none' || mode !== 'full-review'
                ? []
                : [
                    {
                      revision: 1,
                      attempt_id: 'r',
                      verdict: review,
                      sha: head,
                      input_digest: 'i',
                      signature: null,
                      findings: [],
                      valid: true,
                    },
                  ],
          };
          const state = {
            revision: 1,
            run,
            evidence: {
              gates: [
                {
                  revision: 1,
                  step: 'gates',
                  visit: 1,
                  passed: gatePassed,
                  signature: null,
                  valid: true,
                },
              ],
              // A legacy approval record is never what makes a mode task green.
              reviews:
                review === 'approve' && mode !== 'direct-pr'
                  ? [
                      {
                        revision: 1,
                        head_sha: head,
                        verdict: 'approve' as const,
                        valid: true,
                      },
                    ]
                  : [],
              review_skipped: [],
              ci: [],
              base_relations: [],
              publishes: [],
            },
          };
          const v = headVerdict(
            state,
            snapshot,
            head,
            covered
              ? {
                  kind: 'covered',
                  github_required: 'none',
                  github: [],
                  snapshot_only: snapshot,
                }
              : { kind: 'unknown', basis: 'x' },
            {
              head_sha: sameHead ? head : 'b'.repeat(40),
              checks,
              collisions: [],
              complete,
            },
          );
          const single = (n: string) => checks.filter((c) => c.name === n);
          const gateOk = gatePassed && (mode === null || onCheckpoint);
          const reviewOk = mode === 'direct-pr' || review === 'approve';
          const oracle =
            sameHead &&
            covered &&
            complete &&
            gateOk &&
            reviewOk &&
            snapshot.every(
              (n) =>
                single(n).length === 1 &&
                (single(n)[0]!.state === 'success' ||
                  (single(n)[0]!.state === 'skipped' &&
                    checks.every((c) => c.state !== 'failure' && c.state !== 'cancelled'))),
            );
          expect(v.kind === 'green').toBe(oracle);
          if (v.kind === 'green')
            expect(v.review).toBe(mode === 'direct-pr' ? 'not_required' : 'approved');
          if (!sameHead) expect(v.kind).toBe('head_changed');
        },
      ),
      propertyParams(300),
    );
  });
});
