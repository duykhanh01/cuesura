import { hasRole } from '../domain/policy.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { retriage } from './triage.ts';

/**
 * An admin approves a task to continue an existing PR at the head they name. The application has read
 * the PR; here the task must name that PR, must not have started, and no other live task may hold it,
 * read in the same transaction so two tasks can never write one branch. Before the start the approval
 * can be given again, for a head that moved.
 */
/** Shown with the adopt approval; never an approval itself, which still names the head it checked. */
export function onAdoptHeadObserved(
  ctx: Ctx,
  t: Extract<Trigger, { kind: 'adopt_head_observed' }>,
): void {
  const s = ctx.state;
  const w = s.wait;
  if (
    s.status !== 'PENDING' ||
    w?.detail.code !== 'adopt_approval' ||
    s.task.pr_ref?.toLowerCase() !== t.pr_ref.toLowerCase() ||
    w.detail['head_sha'] === t.head_sha
  ) {
    ctx.emit('SignalIgnored', { reason: 'not_applicable', trigger_kind: t.kind });
    return;
  }
  ctx.emit('TaskPending', { wait: { ...w, detail: { ...w.detail, head_sha: t.head_sha } } });
}

export function onAdoptPr(ctx: Ctx, t: Extract<Trigger, { kind: 'adopt_pr' }>): void {
  const s = ctx.state;
  if (!hasRole(ctx.env.authz, 'admin')) reject('not_admin');
  if (s.task.pr_ref?.toLowerCase() !== t.pr_ref.toLowerCase())
    reject('invalid_trigger', { reason: 'pr_ref_mismatch', pr_ref: s.task.pr_ref ?? null });
  if (
    s.policy_ref !== null ||
    (s.status !== 'PENDING' && s.status !== 'READY') ||
    s.execution.holding !== null
  )
    reject('invalid_trigger', { reason: 'adopt_after_start', status: s.status });
  const holders = ctx.related.pr_holders ?? [];
  if (holders.length > 0) reject('pr_in_use', { pr_ref: t.pr_ref, task_ids: holders });
  ctx.emit('PrAdopted', {
    adoption: {
      pr_ref: t.pr_ref,
      head_branch: t.head_branch,
      head_sha: t.head_sha,
      by: ctx.actor,
      at: ctx.now,
    },
  });
  retriage(ctx, ctx.related.deps);
}
