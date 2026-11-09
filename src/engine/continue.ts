import { hasRole } from '../domain/policy.ts';
import { counterKey, streakKey, type DetailCode, type TaskState } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { floorRung } from './escalation.ts';
import { available } from './budget.ts';
import { failWithDraft, pastDeadline, proceed, visitLimit } from './interpreter.ts';

/**
 * `continue` (issue #101): an operator, assistant included, keeps a task on its current model after its quality loop ran out,
 * instead of cancelling it. Accepted only while the task waits because no higher rung can be used
 * (`ladder_exhausted`, `rung_denied`, `escalations_exhausted`) or a step ran out of visits. One
 * continuation clears the escalation streak of the waiting step and of the last fixing step at their
 * current rungs, so each gets `quality_tries_per_rung` fresh tries, and tops up every visited step to at
 * least that many remaining visits. The step then runs again from its wait; gates and review run as
 * usual, and the budget, deadline, ladder and floor are unchanged. Each continuation is bounded and
 * needs its own command.
 */
export const CONTINUABLE: readonly DetailCode[] = [
  'ladder_exhausted',
  'rung_denied',
  'escalations_exhausted',
  'loop_exhausted',
];

type Plan = { step: string; code: DetailCode; streaks: string[] };

/** What a continuation would reopen, or `null` when the task is not waiting on a continuable limit. */
export function continuable(s: TaskState): Plan | null {
  const w = s.wait;
  if (s.status !== 'WAITING' || w === null || s.deadline_passed) return null;
  const code = w.detail.code;
  const step = w.detail['step'];
  if (!CONTINUABLE.includes(code) || typeof step !== 'string') return null;
  // A `loop_exhausted` question raised by a step's own `escalate` outcome is answered, not continued.
  if (code === 'loop_exhausted' && w.detail['outcome'] !== 'exhausted') return null;
  if (w.resume.kind === 'none') return null;
  const streaks = [step, s.last_fix_step].filter(
    (x, i, all): x is string => x !== null && all.indexOf(x) === i,
  );
  return { step, code, streaks };
}

/**
 * Limits the deputy or an operator may lift with `continue` (007, FR-030): the run cap and the deadline
 * only once raised by `amend-policy`; a spent backoff with fresh counters; a spent CI window with a new
 * one of the frozen length. `agent_runs_insufficient` is lifted by `amend-policy --agent-runs` alone.
 */
export const LIMIT_CONTINUABLE: readonly DetailCode[] = [
  'agent_runs_exhausted',
  'deadline',
  'backoff_exhausted',
  'ci_wait_exhausted',
];

export function onContinue(ctx: Ctx): void {
  if (!hasRole(ctx.env.authz, 'operate') && !hasRole(ctx.env.authz, 'admin'))
    reject('invalid_trigger', { reason: 'operate_required' });
  const s = ctx.state;
  const w = s.wait;
  if (
    s.status === 'WAITING' &&
    w !== null &&
    LIMIT_CONTINUABLE.includes(w.detail.code) &&
    // A deadline that fell on running work has nothing to resume; that work goes on.
    (w.resume.kind !== 'none' || w.detail.code === 'deadline')
  )
    return continueLimit(ctx, w);
  const plan = continuable(s);
  if (plan === null) reject('invalid_trigger', { reason: 'continue_not_applicable' });
  const sp = ctx.frozen.steps[plan.step];
  const rung = s.rungs.by_step[plan.step] ?? 0;
  // The task floor still applies: staying below it would bypass the approved policy.
  if (sp !== undefined && floorRung(sp, s.rungs.floor_level) > rung)
    reject('invalid_trigger', { reason: 'continue_below_floor' });

  const tries = ctx.frozen.limits.classes.quality_tries_per_rung;
  const visits: Record<string, number> = {};
  for (const [step, used] of Object.entries(s.step_visits)) {
    const limit = visitLimit(ctx, step);
    if (limit === null) continue;
    const add = used + tries - limit;
    if (add > 0) visits[step] = add;
  }
  ctx.emit('TaskContinued', {
    step: plan.step,
    wait_code: plan.code,
    streaks: plan.streaks.map((x) => streakKey(x, s.rungs.by_step[x] ?? 0)),
    visits,
    by: ctx.actor,
    at: ctx.now,
  });
  ctx.emit('TaskResumed', { reason: 'continued' });
  proceed(ctx, (w as NonNullable<typeof w>).resume, 'continued');
}

function continueLimit(ctx: Ctx, w: NonNullable<TaskState['wait']>): void {
  const s = ctx.state;
  const code = w.detail.code;
  const step = typeof w.detail['step'] === 'string' ? w.detail['step'] : (s.current_step ?? '');
  // Going on under a limit still reached would only open the same wait again.
  if (code === 'agent_runs_exhausted' && available(s.budget) < 1)
    reject('invalid_trigger', { reason: 'agent_runs_still_exhausted' });
  if (code === 'deadline' && pastDeadline(ctx))
    reject('invalid_trigger', { reason: 'deadline_still_passed' });
  const cls = w.detail['class'];
  const head = typeof w.detail['head_sha'] === 'string' ? w.detail['head_sha'] : s.head_sha;
  ctx.emit('TaskContinued', {
    step,
    wait_code: code,
    streaks: [],
    visits: {},
    by: ctx.actor,
    at: ctx.now,
    ...(code === 'backoff_exhausted' && typeof cls === 'string'
      ? { counters: [counterKey(step, cls)] }
      : {}),
    ...(code === 'ci_wait_exhausted' && head !== null ? { ci_window: { head, at: ctx.now } } : {}),
  });
  // A deadline that fell while the task waited on something else returns to that wait.
  const prior = code === 'deadline' ? (w.detail['prior_wait'] as typeof w | undefined) : undefined;
  if (prior !== undefined) {
    ctx.emit('TaskWaiting', { wait: prior });
    return;
  }
  ctx.emit('TaskResumed', { reason: 'continued' });
  proceed(ctx, w.resume, 'continued');
}

/**
 * `task fail` (007, FR-032): the deputy, the owner, or the daemon for them (`system:deputy-absent`,
 * `system:loop-guard`) ends a task that waits, through the same draft-PR path as #247.
 */
export function onFail(ctx: Ctx, t: Extract<Trigger, { kind: 'fail' }>): void {
  if (!hasRole(ctx.env.authz, 'operate') && !hasRole(ctx.env.authz, 'admin'))
    reject('invalid_trigger', { reason: 'operate_required' });
  if (ctx.state.status !== 'WAITING') reject('invalid_trigger', { reason: 'fail_not_waiting' });
  failWithDraft(ctx, t.reason);
}
