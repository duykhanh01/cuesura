import type { Uuid } from '../../src/shared/brand.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import { reviewInputDigest } from '../../src/engine/review-evidence.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { buildTask, freezeOk, uuidOf } from './builders.ts';
import { agentData, gatesData, PREPARE_DATA, publishData, reviewData } from './scenario.ts';
import type { StoreDriver } from './store-driver.ts';

export const WALL = 3_600_000;

export function createAndStart(d: StoreDriver, task: CanonicalTask): void {
  d.must(task.id, { kind: 'create_task', task });
  d.must(task.id, {
    kind: 'start',
    freeze: freezeOk(task, { limits: { max_wall_ms: WALL } }),
  });
}

/**
 * Stop before publish. Mode-aware tasks use the gate checkpoint and publish it before any review
 * (full-review reviews the pushed checkpoint after the PR, see {@link reviewToCi}); a legacy task
 * without a mode still reviews before publish.
 */
export function toPublish(
  d: StoreDriver,
  task: CanonicalTask,
  head = 'head1',
  coder: Record<string, unknown> = {},
): void {
  d.complete(task.id, d.pendingOne(task.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(
    task.id,
    d.pendingOne(task.id, 'start_agent').id,
    'succeeded',
    agentData('done', coder),
  );
  const mode = d.task(task.id).run.mode;
  d.complete(
    task.id,
    d.pendingOne(task.id, 'run_gates').id,
    'succeeded',
    mode === null ? gatesData({ build: true, unit: true }) : checkpointGates(head),
  );
  if (mode !== null) return;
  d.complete(
    task.id,
    d.pendingOne(task.id, 'start_agent').id,
    'succeeded',
    reviewData(
      'approve',
      head,
      mode === null ? {} : { input_digest: currentReviewInput(d, task.id) },
    ),
  );
}

/** Completes the task's pending post_review with `outcome`, for the attempt it was asked to post. */
export function completePost(
  d: StoreDriver,
  taskId: string,
  outcome: 'posted' | 'not_posted' | 'unknown' = 'posted',
): void {
  const e = d.pendingOne(taskId, 'post_review');
  d.complete(taskId, e.id, 'succeeded', {
    attempt_id: e.request['attempt_id'],
    outcome,
    review_id: outcome === 'posted' ? 1 : null,
    inline: 0,
    detail: outcome === 'posted' ? null : 'HTTP 502',
  });
}

/**
 * A full-review task from its gate checkpoint to the review: publish `head`, open (or keep) the PR and
 * hand the review the slot. Stops with the reviewer's start_agent pending, or wherever the task stopped
 * instead.
 */
export function publishToReview(d: StoreDriver, taskId: string, head: string): void {
  d.complete(taskId, d.pendingOne(taskId, 'publish').id, 'succeeded', publishData(head));
  const pr = d.pending(taskId, 'create_pr');
  if (pr.length === 1)
    d.complete(taskId, pr[0]!.id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: head,
    });
  if (d.task(taskId).wait?.detail['code'] === 'execution_slot') d.grantNext();
}

/**
 * After the PR step of a full-review task: the review approves the checkpoint, its comment is posted and
 * the draft PR turned ready, leaving the task at the CI wait. A no-op for other modes.
 */
export function reviewToCi(
  d: StoreDriver,
  taskId: string,
  verdict: 'approve' | 'request_changes' = 'approve',
): void {
  const s = d.task(taskId);
  if (s.run.mode !== 'full-review') return;
  const head = s.run.checkpoint?.sha;
  if (head === undefined) throw new Error('no checkpoint to review');
  // The PR step holds no slot, so the review queues for it again.
  if (s.wait?.detail['code'] === 'execution_slot') d.grantNext();
  d.complete(
    taskId,
    d.pendingOne(taskId, 'start_agent').id,
    'succeeded',
    reviewData(verdict, head, {
      input_digest: currentReviewInput(d, taskId),
    }),
  );
  completePost(d, taskId);
  if (verdict !== 'approve') return;
  d.complete(taskId, d.pendingOne(taskId, 'mark_ready').id, 'succeeded', {
    pr_ref: d.task(taskId).pr_ref,
    ready_at: null,
  });
}

export const TREE = 'e'.repeat(40);
export const CONTENT_DIGEST = hashCanonical('content');

/** Gates that passed on one tree and the checkpoint commit `sha` of it. */
export function checkpointGates(
  sha: string,
  results: Record<string, boolean> = { build: true, unit: true },
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...gatesData(results),
    tree: TREE,
    stable: true,
    checkpoint: {
      sha,
      tree: TREE,
      base_sha: 'base0000',
      diff_digest: hashCanonical(`diff:${sha}`),
      content_digest: CONTENT_DIGEST,
      committed: true,
    },
    ...over,
  };
}

/** The review input digest the engine expects for the task's current checkpoint. */
export function currentReviewInput(d: StoreDriver, taskId: string): string {
  const s = d.task(taskId);
  const ref = s.policy_ref;
  const policy =
    ref === null ? null : d.store.readPolicy(taskId as Uuid, ref.revision, ref.version);
  const digest = policy === null ? null : reviewInputDigest(s, policy, 'review');
  if (digest === null) throw new Error('no review input');
  return digest;
}

/**
 * Multi-task workload with duplicates, rejections, conflicts, cancellation, and timers for crash
 * and replay tests.
 */
export function mixedWorkload(d: StoreDriver): CanonicalTask[] {
  const a = buildTask({ id: uuidOf(101), source_key: 'cli:a' });
  const b = buildTask({ id: uuidOf(102), source_key: 'cli:b' });
  const c = buildTask({
    id: uuidOf(103),
    source_key: 'cli:c',
    depends_on: [a.id],
  });

  createAndStart(d, a);
  d.must(b.id, { kind: 'create_task', task: b });
  d.must(c.id, { kind: 'create_task', task: c });
  toPublish(d, a);

  const last = d.ops.findLast((o) => o.op === 'accept');
  if (last?.op === 'accept') d.deliver(last.envelope);
  d.send(b.id, { kind: 'cancel', reason: 'stale request' }, { expected_version: 0 });
  d.complete(a.id, d.pendingOne(a.id, 'publish').id, 'succeeded', publishData('head1'));
  d.must(b.id, {
    kind: 'start',
    freeze: freezeOk(b, { limits: { max_wall_ms: WALL } }),
  });
  d.must(b.id, { kind: 'cancel', reason: 'No longer needed' });
  d.send(uuidOf(999), { kind: 'confirm_task' });
  d.now += WALL;
  d.fire();
  return [a, b, c];
}

export function asUuid(id: string): Uuid {
  return id as Uuid;
}
