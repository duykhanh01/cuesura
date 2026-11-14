import { canonicalJson } from '../shared/canonical-json.ts';
import type { TaskState, TaskStatus, Wait } from '../domain/state.ts';
import type { CanonicalTask } from '../domain/task.ts';
import type { RelatedFacts } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { mkWait } from './waits.ts';

export function checkDependencies(task: CanonicalTask, related: RelatedFacts): void {
  if (task.depends_on.includes(task.id)) reject('dependency_invalid', { reason: 'self_reference' });
  const missing = task.depends_on.filter((d) => (related.deps[d] ?? 'missing') === 'missing');
  if (missing.length > 0) reject('dependency_invalid', { reason: 'missing', depends_on: missing });
  if (related.dependency_cycle) reject('dependency_invalid', { reason: 'dependency_cycle' });
}

export function checkRetryOf(task: CanonicalTask, related: RelatedFacts): void {
  if (task.retry_of === null) return;
  const st = related.retry_of ?? 'missing';
  if (st !== 'DONE' && st !== 'FAILED' && st !== 'CANCELLED') {
    reject('invalid_trigger', {
      reason: 'retry_of_not_terminal',
      retry_of: task.retry_of,
      status: st,
    });
  }
}

/** The task names an existing PR, and no admin has adopted that PR for it. */
function adoptionPending(s: TaskState): boolean {
  const wanted = s.task.pr_ref;
  return wanted !== undefined && s.adoption?.pr_ref.toLowerCase() !== wanted.toLowerCase();
}

export function pendingWait(ctx: Ctx, deps: Record<string, TaskStatus | 'missing'>): Wait | null {
  const s = ctx.state;
  if (s.needs_confirmation && !s.confirmed) {
    return mkWait('confirmation', 'needs_confirmation', {
      resume: { kind: 'triage' },
      resume_when: ['confirm_task'],
    });
  }
  if (s.task.acceptance.length === 0) {
    return mkWait('needs_info', 'missing_acceptance', {
      resume: { kind: 'triage' },
      resume_when: ['source_updated(acceptance)'],
    });
  }
  if (adoptionPending(s)) {
    // Keep the head the daemon last read, so a retriage does not drop it from the approval.
    const w = s.wait;
    const seen =
      w?.detail.code === 'adopt_approval' && w.detail['pr_ref'] === s.task.pr_ref
        ? w.detail['head_sha']
        : undefined;
    return mkWait('confirmation', 'adopt_approval', {
      resume: { kind: 'triage' },
      resume_when: ['approve(adopt)'],
      detail: { pr_ref: s.task.pr_ref, ...(typeof seen === 'string' ? { head_sha: seen } : {}) },
    });
  }
  // A task of a planned goal waits on the current task of each unit key (R-29); a unit FAILED while
  // the goal replans is waited on, not a failed dependency.
  const goalDeps = ctx.related.goal_deps;
  const replan = goalDeps?.replan ?? [];
  const status = (goalDeps?.ids ?? s.task.depends_on).map(
    (d) => [d, deps[d] ?? 'missing'] as const,
  );
  const failed = status.filter(
    ([d, st]) => !replan.includes(d) && (st === 'FAILED' || st === 'CANCELLED' || st === 'missing'),
  );
  if (failed.length > 0) {
    return mkWait('dependency', 'dependency_failed', {
      resume: { kind: 'triage' },
      resume_when: ['source_updated(depends_on)'],
      detail: { deps: Object.fromEntries(failed) },
    });
  }
  const waiting = status.filter(([, st]) => st !== 'DONE');
  const replanning = waiting.filter(([d]) => replan.includes(d)).map(([d]) => d);
  // A unit dispatches only once its goal branch exists (contracts/goal.md, "Khi xác nhận").
  const branch = ctx.related.goal_branch;
  const noBranch = branch !== undefined && !branch.created;
  if (waiting.length > 0 || noBranch) {
    return mkWait('dependency', 'dependency_pending', {
      resume: { kind: 'triage' },
      resume_when: [
        ...waiting.map(([d]) => `dependency_status(${d}=DONE)`),
        ...(replanning.length > 0 ? ['goal_amend(replace unit)'] : []),
        ...(noBranch ? ['goal_branch_ready'] : []),
      ],
      detail: {
        deps: Object.fromEntries(waiting),
        ...(replanning.length > 0 ? { replan: replanning } : {}),
        ...(noBranch ? { goal_branch: branch.name } : {}),
      },
    });
  }
  return null;
}

export function retriage(ctx: Ctx, deps: Record<string, TaskStatus | 'missing'>): void {
  const s = ctx.state;
  if (s.status !== 'PENDING' && s.status !== 'READY') return;
  const wait = pendingWait(ctx, deps);
  if (wait === null) {
    if (s.status !== 'READY') ctx.emit('TaskReady', {});
    return;
  }
  if (s.status === 'PENDING' && canonicalJson(s.wait) === canonicalJson(wait)) return;
  ctx.emit('TaskPending', { wait });
}
