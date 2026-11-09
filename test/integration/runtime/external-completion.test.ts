import { describe, expect, it } from 'vitest';
import type { MergeProof } from '../../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, ciData, PREPARE_DATA, publishData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { cancelRef, observation } from '../../support/observation.ts';
import { toPublish, reviewToCi } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-completion-');
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function proof(over: Partial<MergeProof> = {}): MergeProof {
  return {
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
    ...over,
  };
}

function setup() {
  return new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
}

/** Runtime task through code, gates, review, publish, PR and green CI to the merge gate. */
function toMergeGate(d: StoreDriver, task: CanonicalTask): void {
  createGrantStart(d, task);
  toPublish(d, task, HEAD);
  d.complete(task.id, d.pendingOne(task.id, 'publish').id, 'succeeded', publishData(HEAD));
  d.complete(task.id, d.pendingOne(task.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: HEAD,
  });
  reviewToCi(d, task.id);
  d.complete(
    task.id,
    d.pendingOne(task.id, 'await_ci').id,
    'succeeded',
    ciData(HEAD, { build: 'success', test: 'success' }),
  );
}

/** The observation that saw the merge; a proof is only accepted for a recorded `merged` observation. */
function observeMerged(d: StoreDriver, t: CanonicalTask, id = 'obs-1'): void {
  const p = proof();
  d.must(t.id, {
    kind: 'observation_result',
    observation: {
      observation_id: id,
      source: 'timer',
      requested_at: d.now,
      observed_at: d.now,
      generation: 1,
      subject: p.subject,
      status: 'merged',
      observed_head: HEAD,
      raw_evidence_ref: 'ev-1',
      completeness: { merge_proof: true, quality: false },
    },
    remote_digest: `sha256:${'d'.repeat(64)}`,
  });
}

function complete(d: StoreDriver, t: CanonicalTask, over: Partial<MergeProof> = {}) {
  return d.must(t.id, {
    kind: 'external_completion',
    proof: proof(over),
    unverified_reason: null,
  });
}

const types = (d: StoreDriver, t: CanonicalTask) => d.store.readEvents(t.id).map((e) => e.type);

describe('external confirmation (T045, FR-021, FR-040)', () => {
  it('a green PR waits for the merge on GitHub: no approval request, no merge effect, no base-tip demand', () => {
    const d = setup();
    const t = buildTask();
    toMergeGate(d, t);
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'approval',
        detail: {
          code: 'merge',
          mode: 'external_confirmation',
          head_sha: HEAD,
        },
      },
    });
    expect(types(d, t)).not.toContain('ApprovalRequested');
    expect(d.pending(t.id, 'merge')).toEqual([]);
    expect(d.store.readSlots()).toMatchObject([{ holder_task_id: t.id, reserved_at: d.now }]);
  });

  it('a merge proof is recorded once, waits for cleanup first, and ends business work', () => {
    const d = setup();
    const t = buildTask();
    toMergeGate(d, t);
    observeMerged(d, t);
    complete(d, t);
    const s = d.task(t.id);
    // Nothing was in flight at the merge gate, so the drain (T046) finished in the same decision.
    const seen: string[] = types(d, t);
    const order = [
      'ExternalCompletionObserved',
      'DrainStarted',
      'DrainFinished',
      'TaskCompleted',
    ].map((x) => seen.indexOf(x));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > (order[k - 1] as number)))).toBe(true);
    const cleanup = d.store
      .readEvents(t.id)
      .find(
        (e) =>
          e.type === 'TaskWaiting' && JSON.stringify(e.payload).includes('merge_cleanup_pending'),
      );
    expect(cleanup?.payload).toMatchObject({
      wait: {
        reason: 'policy',
        detail: { code: 'merge_cleanup_pending', unverified_reason: null },
      },
    });
    expect(s).toMatchObject({ status: 'DONE', merged: true });
    expect(s.completion).toMatchObject({
      proof: { merged_head_sha: HEAD, checked_head_sha: HEAD },
      unverified: null,
    });
    expect(Object.values(s.timers).filter((x) => x.status === 'armed')).toEqual([]);

    // The same proof again is logged, never recorded twice.
    complete(d, t);
    expect(types(d, t).filter((x) => x === 'ExternalCompletionObserved')).toHaveLength(1);
  });

  it('a merge of a head Cuesura did not check is recorded as unverified, without asking for approval', () => {
    const d = setup();
    const t = buildTask();
    toMergeGate(d, t);
    observeMerged(d, t);
    complete(d, t, { merged_head_sha: OTHER });
    expect(d.task(t.id).completion).toMatchObject({
      proof: { merged_head_sha: OTHER, checked_head_sha: HEAD },
      unverified: { reason: 'merged_head_unverified' },
    });
  });

  it('a merge proof before the task has a PR is refused', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    const agent = d.pendingOne(t.id, 'start_agent');
    expect(d.claim(agent.id).ok).toBe(true);
    // Fake a PR to merge: the user merged a PR opened earlier for this task.
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: agent.id as Uuid,
      outcome: 'succeeded',
      data: agentData('done'),
    });
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      results: [
        { gate: 'build', passed: false, signature: 's' },
        { gate: 'unit', passed: true },
      ],
    });
    const fixer = d.pendingOne(t.id, 'start_agent');
    expect(fixer.status).toBe('pending');
    // No PR yet: an external completion without a PR is refused.
    expect(
      d.send(t.id, {
        kind: 'external_completion',
        proof: proof(),
        unverified_reason: null,
      }),
    ).toMatchObject({
      ok: true,
      value: { decision: { kind: 'rejected', detail: { reason: 'no_pr' } } },
    });
  });

  it('refuses a proof without a recorded merged observation', () => {
    const d = setup();
    const t = buildTask();
    toMergeGate(d, t);
    expect(
      d.send(t.id, {
        kind: 'external_completion',
        proof: proof(),
        unverified_reason: null,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'observation_missing' },
        },
      },
    });
  });

  it('refuses a proof for another target branch', () => {
    const d = setup();
    const t = buildTask({ id: uuidOf(2), source_key: 'cli:2' });
    toMergeGate(d, t);
    const r = d.send(t.id, {
      kind: 'external_completion',
      proof: proof({ subject: { ...proof().subject, target_ref: 'release' } }),
      unverified_reason: null,
    });
    expect(r).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'merge_target_mismatch' },
        },
      },
    });
  });

  it.each([false, true])(
    '#179: a cancel read of a PR GitHub moved to another base (merged there: %s) ends the cancel',
    (merged) => {
      const d = setup();
      const t = buildTask();
      toMergeGate(d, t);
      d.must(t.id, { kind: 'cancel', reason: 'stop' });
      d.now += 1_000;
      // The PR's base branch was deleted and GitHub retargeted it: the read is not of the task's target.
      d.must(
        t.id,
        observation(d, t, 'unknown', HEAD, {
          source: 'cancel',
          ref: cancelRef(d, t),
          target: { ref: 'release', merged },
        }),
      );
      expect(d.task(t.id)).toMatchObject({
        status: 'CANCELLED',
        completion: null,
        cancellation: { pr_read: { status: 'unknown', target: { ref: 'release', merged } } },
      });
    },
  );

  it('#179: a cancel read that could not read the PR keeps the cancel waiting and says so', () => {
    const d = setup();
    const t = buildTask();
    toMergeGate(d, t);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    d.now += 1_000;
    d.must(t.id, observation(d, t, 'unknown', null, { source: 'cancel', ref: cancelRef(d, t) }));
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        detail: { code: 'cancel_reconcile', last_cancel_read: { status: 'unknown' } },
      },
    });
  });

  it('#179: cancel --force ends a cancel the read left waiting; a later merge stays history', () => {
    const d = setup();
    const t = buildTask();
    toMergeGate(d, t);
    // A force with no cancel yet is a plain cancel: the PR read still comes first.
    d.must(t.id, { kind: 'cancel', reason: 'stop', force: true });
    expect(d.task(t.id).wait?.detail.code).toBe('cancel_reconcile');
    d.now += 1_000;
    d.must(t.id, observation(d, t, 'unknown', null, { source: 'cancel', ref: cancelRef(d, t) }));
    d.must(t.id, { kind: 'cancel', reason: 'stop', force: true });
    expect(d.task(t.id)).toMatchObject({
      status: 'CANCELLED',
      cancellation: { forced: { at: d.now } },
    });
    complete(d, t);
    expect(d.task(t.id)).toMatchObject({ status: 'CANCELLED', completion: null });
  });

  it('#179: cancel --force is ignored once a merge was seen', () => {
    const d = setup();
    const t = buildTask();
    toMergeGate(d, t);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    d.now += 1_000;
    d.must(t.id, observation(d, t, 'merged', HEAD, { source: 'cancel', ref: cancelRef(d, t) }));
    const before = d.task(t.id).status;
    const r = d.send(t.id, { kind: 'cancel', reason: 'stop', force: true });
    expect(r).toMatchObject({
      ok: true,
      value: {
        decision: { events: [{ type: 'SignalIgnored', payload: { reason: 'merge_seen' } }] },
      },
    });
    expect(d.task(t.id).status).toBe(before);
    expect(d.task(t.id).cancellation?.forced).toBeUndefined();
  });

  it('a cancelled task is not reopened by a later merge', () => {
    const d = setup();
    const t = buildTask();
    toMergeGate(d, t);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    // The PR is read once after the request before the cancel may end (FR-025.03).
    expect(d.task(t.id).wait?.detail.code).toBe('cancel_reconcile');
    d.now += 1_000;
    d.must(
      t.id,
      observation(d, t, 'open', HEAD, {
        source: 'recheck',
        ref: cancelRef(d, t),
      }),
    );
    expect(d.task(t.id).status).toBe('CANCELLED');
    complete(d, t);
    expect(d.task(t.id)).toMatchObject({
      status: 'CANCELLED',
      completion: null,
    });
  });
});
