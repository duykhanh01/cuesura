import { DEFAULT_RUNTIME_LIMITS } from '../domain/runtime.ts';
import type { Trigger } from '../domain/trigger.ts';
import { invalidatePending } from './cancel.ts';
import { reject, type Ctx } from './context.ts';
import { startDrain } from './drain.ts';
import { reviewOf } from './head-evidence.ts';
import { ciVerdict, latestCi } from './merge-guard.ts';
import { mkWait, waitTask } from './waits.ts';

/**
 * External confirmation (T045, FR-021, FR-040.01–03/10–15, research R-02). A runtime (002) task never
 * merges: at the merge gate it waits for the user to merge on GitHub, without a made-up approval, a
 * merge effect or a demand that the head contain the newest base. A durable merge proof then ends all
 * business work of the task, whatever it was doing: pending business effects and timers are invalidated,
 * the open execution request is withdrawn, and the merged and checked heads are recorded with an
 * unverified disclaimer when Cuesura did not vouch for the merged head. Completion goes before source
 * drift and the deadline; a terminal task is never reopened (the dispatcher only logs it).
 */

/** Runtime tasks complete by external confirmation only (the snapshot's completion_mode is fixed). */
export function externalConfirmation(ctx: Ctx): boolean {
  return ctx.state.runtime_ref !== null;
}

/** The merge gate of a runtime task: wait for the merge on GitHub; no approval request, no merge effect. */
export function waitForExternalMerge(ctx: Ctx, step: string): void {
  waitTask(
    ctx,
    mkWait('approval', 'merge', {
      resume: { kind: 'none' },
      resume_when: ['external_completion'],
      exit_paths: ['merge the PR on GitHub', 'cancel'],
      detail: { step, mode: 'external_confirmation', head_sha: ctx.state.head_sha, pr_ref: ctx.state.pr_ref },
    }),
  );
}

/**
 * Whether Cuesura vouched for `head` under the task's confirmed mode (FR-040.11, M08): it is the head this
 * revision published, with no recorded head drift; with a mode it is the checkpoint the gates passed on;
 * `full-review` (and a legacy task) needs the review approving it, `direct-pr` needs none; and the latest
 * CI evidence for it passed. Anything else is merged but unverified.
 */
function verifiedHead(ctx: Ctx, head: string): boolean {
  const s = ctx.state;
  if (s.head_sha !== head || s.run.head_drift !== null) return false;
  if (s.run.mode !== null && (s.run.checkpoint === null || s.run.checkpoint.revision !== s.revision || s.run.checkpoint.sha !== head)) return false;
  const ci = latestCi(s, head);
  return reviewOf(s, head) !== 'missing' && ci !== undefined && ciVerdict(ctx.frozen, ci.required_set, ci.checks).kind === 'pass';
}

type ExternalCompletion = Extract<Trigger, { kind: 'external_completion' }>;

export function onExternalCompletion(ctx: Ctx, t: ExternalCompletion): void {
  const s = ctx.state;
  if (!externalConfirmation(ctx)) reject('invalid_trigger', { reason: 'not_external_confirmation' });
  if (s.pr_ref === null) reject('invalid_trigger', { reason: 'no_pr' });
  if (t.proof.subject.target_ref !== s.task.base_branch) reject('invalid_trigger', { reason: 'merge_target_mismatch', target: t.proof.subject.target_ref });
  const last = s.observation?.last ?? null;
  if (last === null || last.observation_id !== t.proof.observation_id || last.status !== 'merged') {
    reject('invalid_trigger', { reason: 'observation_missing', observation_id: t.proof.observation_id });
  }
  if (s.completion !== null) {
    const same = s.completion.proof.merge_commit_sha === t.proof.merge_commit_sha && s.completion.proof.subject.subject_id === t.proof.subject.subject_id;
    ctx.emit('SignalIgnored', { reason: same ? 'completion_recorded' : 'completion_conflict', trigger_kind: t.kind, detail: { merge_commit_sha: t.proof.merge_commit_sha } });
    return;
  }

  const checked = s.head_sha;
  const unverified = t.unverified_reason ?? (verifiedHead(ctx, t.proof.merged_head_sha) ? null : 'merged_head_unverified');
  ctx.emit('ExternalCompletionObserved', { proof: { ...t.proof, checked_head_sha: checked }, unverified_reason: unverified, at: ctx.now });

  // No new business work after a merge: pending business effects and every armed timer go; effects
  // already started keep running until the drain stops or reconciles them (FR-040.04–06).
  invalidatePending(ctx, 'merged', () => true);
  for (const timer of Object.values(ctx.state.timers)) {
    if (timer.status === 'armed') ctx.emit('TimerCancelled', { timer_id: timer.id });
  }
  const r = ctx.state.execution.request;
  if (r !== null) ctx.emit('ExecutionWithdrawn', { request_id: r.request_id, reason: 'completion', at: ctx.now });
  // Emitted directly, not through waitTask: completion outranks a pending source drift.
  ctx.emit('TaskWaiting', {
    wait: mkWait('policy', 'merge_cleanup_pending', {
      resume: { kind: 'none' },
      resume_when: ['drain_result', 'recheck(drain)'],
      exit_paths: ['recheck'],
      detail: { merged_head_sha: t.proof.merged_head_sha, checked_head_sha: checked, unverified_reason: unverified },
    }),
  });
  startDrain(ctx);
}

type ObservationResult = Extract<Trigger, { kind: 'observation_result' }>;

/**
 * Records one observation of the task's PR. The first one opens the observation window with the default
 * runtime caps; budgets, cadence and expiry belong to the observation service (T059). A merge proof is
 * accepted later only for an observation recorded here with status `merged`.
 */
export function onObservationResult(ctx: Ctx, t: ObservationResult): void {
  const s = ctx.state;
  const o = t.observation;
  if (s.pr_ref === null) reject('invalid_trigger', { reason: 'no_pr' });
  if (o.subject.target_ref !== s.task.base_branch) reject('invalid_trigger', { reason: 'observation_target_mismatch', target: o.subject.target_ref });
  if (s.observation !== null && JSON.stringify(s.observation.subject) !== JSON.stringify(o.subject)) reject('invalid_trigger', { reason: 'observation_subject_mismatch' });
  if (s.observation === null) {
    ctx.emit('ObservationScheduled', {
      subject: o.subject,
      started_at: ctx.now,
      deadline_at: ctx.now + DEFAULT_RUNTIME_LIMITS.observation_max_ms,
      max_count: DEFAULT_RUNTIME_LIMITS.observation_max_rounds,
      next_due_at: ctx.now,
      cadence_index: 0,
      generation: o.generation,
    });
  }
  ctx.emit('ExternalStateObserved', { observation: o, remote_digest: t.remote_digest });
}
