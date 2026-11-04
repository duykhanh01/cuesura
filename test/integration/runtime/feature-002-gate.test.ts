/** Gate A: durable confirmation and callback ordering across an actual SQLite close/reopen. */
import { describe, expect, it } from 'vitest';
import { selectionDigest } from '../../../src/domain/run-config.ts';
import { reviewInputDigest, reusableReview } from '../../../src/engine/review-evidence.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, ownerAuthz } from '../../support/builders.ts';
import { createGrantStart, selectionFor } from '../../support/runtime.ts';
import { agentData, reviewData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import {
  checkpointGates,
  currentReviewInput,
  toPublish,
  publishToReview,
  reviewToCi,
} from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-gate-a-');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe.each(['direct-pr', 'full-review'] as const)('M02 durable confirmation in %s', (mode) => {
  it('keeps the owner confirmation and dedup outcome after reopening, then invalidates it for a new proposal', () => {
    const path = dbPath(tempDir());
    const task = buildTask();
    const d = new StoreDriver(openFileStoreForTest(path));
    d.must(task.id, { kind: 'create_task', task });
    const selection = selectionFor(task, mode);
    d.must(task.id, { kind: 'propose_run_config', selection });
    const confirmation = d.envelope(
      task.id,
      {
        kind: 'confirm_run_config',
        digest: selectionDigest(selection),
      },
      { authz: ownerAuthz() },
    );
    const accepted = d.deliver(confirmation);
    expect(accepted.ok).toBe(true);
    const before = d.task(task.id);
    d.store.close();
    const reopened = new StoreDriver(openFileStoreForTest(path), 100_000);
    try {
      expect(reopened.task(task.id)).toEqual(before);
      if (!accepted.ok) throw new Error('confirmation rejected');
      expect(reopened.deliver(confirmation)).toEqual({
        ok: true,
        value: { ...accepted.value, duplicate: true },
      });
      expect(reopened.task(task.id).version).toBe(before.version);
      reopened.must(task.id, {
        kind: 'propose_run_config',
        selection: { ...selection, reason: 'new choice' },
      });
      expect(reopened.task(task.id).run.confirmation?.digest).not.toBe(
        reopened.task(task.id).run.proposal?.digest,
      );
      expect(
        reopened.send(
          task.id,
          { kind: 'confirm_run_config', digest: selectionDigest(selection) },
          { authz: ownerAuthz() },
        ),
      ).toMatchObject({
        ok: true,
        value: { decision: { kind: 'rejected' } },
      });
      expect(reopened.pending(task.id)).toEqual([]);
      expect(reopened.store.verifyProjections()).toMatchObject({
        ok: true,
        mismatches: [],
      });
    } finally {
      reopened.store.close();
    }
  });
});

describe.each([true, false])(
  'H05 SQLite reopen, callback ingested before drift: %s',
  (callbackFirst) => {
    it('keeps drift and the A-bound result, deduplicates its redelivery, and never creates another reviewer or publish', () => {
      const path = dbPath(tempDir());
      const d = new StoreDriver(openFileStoreForTest(path));
      const task = buildTask();
      createGrantStart(d, task, 'full-review');
      d.complete(task.id, d.pendingOne(task.id, 'prepare').id, 'succeeded', {
        base_sha: 'base0000',
        worktree_ref: 'wt',
        branch: 'b',
        setup: { ran: false, passed: true },
      });
      d.complete(task.id, d.pendingOne(task.id, 'start_agent').id, 'succeeded', agentData('done'));
      d.complete(task.id, d.pendingOne(task.id, 'run_gates').id, 'succeeded', checkpointGates(A));
      publishToReview(d, task.id, A);
      const reviewer = d.pendingOne(task.id, 'start_agent');
      expect(d.claim(reviewer.id).ok).toBe(true);
      // This simulates an already normalized callback, not recovery from runner files (T082/T093).
      const callback = d.envelope(task.id, {
        kind: 'effect_result',
        effect_id: reviewer.id as Uuid,
        outcome: 'succeeded',
        data: reviewData('approve', A, {
          input_digest: currentReviewInput(d, task.id),
        }),
      });
      if (callbackFirst) expect(d.deliver(callback).ok).toBe(true);
      d.must(task.id, {
        kind: 'head_drift',
        expected: A,
        observed: B,
        source: 'observation',
        evidence_ref: 'obs:B',
      });
      d.store.close();
      const reopened = new StoreDriver(openFileStoreForTest(path), 100_000);
      try {
        expect(reopened.deliver(callback).ok).toBe(true);
        const beforeDuplicate = reopened.task(task.id);
        const usageEvents = reopened.store
          .readEvents(task.id)
          .filter((e) => e.type === 'BudgetConsumed');
        expect(reopened.deliver(callback).ok).toBe(true);
        expect(reopened.task(task.id)).toEqual(beforeDuplicate);
        expect(
          reopened.store.readEvents(task.id).filter((e) => e.type === 'BudgetConsumed'),
        ).toEqual(usageEvents);
        expect(beforeDuplicate.run.head_drift).toMatchObject({
          expected: A,
          observed: B,
        });
        expect(beforeDuplicate.blockers.map((b) => b.code)).toContain('head_changed');
        expect(beforeDuplicate.effects[reviewer.id]?.status).toBe('succeeded');
        expect(beforeDuplicate.head_sha).not.toBe(B);
        expect(reopened.pending(task.id, 'post_review')).toEqual([]);
        expect(
          Object.values(beforeDuplicate.effects).filter(
            (e) => e.step === 'review' && e.kind === 'start_agent',
          ),
        ).toHaveLength(1);
        expect(reopened.store.verifyProjections()).toMatchObject({
          ok: true,
          mismatches: [],
        });
      } finally {
        reopened.store.close();
      }
    });
  },
);

describe('M03 review input validity', () => {
  it('never reuses approval after acceptance/context, base or reviewer policy changes', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const task = buildTask();
    try {
      createGrantStart(d, task, 'full-review');
      toPublish(d, task, A);
      publishToReview(d, task.id, A);
      reviewToCi(d, task.id);
      const s = d.task(task.id);
      const policy = d.store.readPolicy(task.id, 1);
      if (policy === null || s.context_ref === null || s.run.checkpoint === null)
        throw new Error('missing snapshot');
      const original = reviewInputDigest(s, policy, 'review');
      if (original === null) throw new Error('missing digest');
      expect(reusableReview(s, original)?.verdict).toBe('approve');
      const inputs = [
        reviewInputDigest(
          {
            ...s,
            context_ref: {
              ...s.context_ref,
              hash: hashCanonical('changed-context'),
            },
          },
          policy,
          'review',
        ),
        reviewInputDigest(
          {
            ...s,
            run: { ...s.run, checkpoint: { ...s.run.checkpoint, base_sha: B } },
          },
          policy,
          'review',
        ),
        reviewInputDigest(
          s,
          { ...policy, structure_hash: hashCanonical('changed-policy') },
          'review',
        ),
      ];
      for (const input of inputs) {
        expect(input).not.toBe(original);
        expect(reusableReview(s, input ?? '')).toBeUndefined();
      }
    } finally {
      d.store.close();
    }
  });
});

it('T139 M02: SQLite replay keeps a legacy runtime without merge.method and its original hash', () => {
  const path = dbPath(tempDir());
  const task = buildTask();
  const d = new StoreDriver(openFileStoreForTest(path));
  createGrantStart(d, task, 'direct-pr');
  const before = d.store.readRuntimeContext(task.id, 1);
  expect(before).not.toHaveProperty('merge_method');
  d.store.close();
  const reopened = openFileStoreForTest(path);
  try {
    expect(reopened.readRuntimeContext(task.id, 1)).toEqual(before);
    expect(reopened.verifyProjections().ok).toBe(true);
  } finally {
    reopened.close();
  }
});
