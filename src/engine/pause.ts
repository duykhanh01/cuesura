import { hasRole } from '../domain/policy.ts';
import { isTerminal, type ResumeAction } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { onStopAttempt } from './decide.ts';
import { proceed } from './interpreter.ts';
import { mkWait, waitTask } from './waits.ts';

/**
 * `pause`/`unpause` (issue #142). A paused task finishes the work already handed out (a running
 * attempt, gate or GitHub action) and starts nothing new: the next step, retry or resumed wait stops
 * at {@link waitPaused} with the action it would have run, and the slot goes back to the queue once no
 * slot-bound work is left. With `now`, running agent attempts are stopped as `stop_attempt` stops them
 * and start over in a new session on resume; gates and GitHub actions still finish. Unpausing runs the
 * held action, so the task goes on from the same step with the same revision, rung, worktree, PR and
 * evidence. Waits on CI, a person or GitHub keep being
 * observed while paused; what they lead to waits for the unpause.
 */

type PauseTrigger = Extract<Trigger, { kind: 'pause' }>;

function requireOperator(ctx: Ctx): void {
  if (!hasRole(ctx.env.authz, 'operate') && !hasRole(ctx.env.authz, 'admin'))
    reject('invalid_trigger', { reason: 'operate_required' });
}

export function isPaused(ctx: Pick<Ctx, 'state'>): boolean {
  return (ctx.state.pause ?? null) !== null;
}

/** Whether `pause --now` stopped this attempt, so its end starts the step over rather than asking. */
export function stoppedByPause(ctx: Pick<Ctx, 'state'>, attemptId: string): boolean {
  return ctx.state.pause_stops?.includes(attemptId) ?? false;
}

/** Holds `resume` until the task is unpaused. */
export function waitPaused(ctx: Ctx, resume: ResumeAction): void {
  const p = ctx.state.pause;
  waitTask(
    ctx,
    mkWait('policy', 'paused', {
      resume,
      resume_when: ['unpause'],
      exit_paths: ['cusr task resume', 'cancel'],
      detail: { reason: p?.reason ?? null, by: p?.by ?? null, at: p?.at ?? null },
    }),
  );
}

export function onPause(ctx: Ctx, t: PauseTrigger): void {
  requireOperator(ctx);
  const s = ctx.state;
  if (isTerminal(s.status) || s.completion !== null || s.cancellation !== null)
    reject('invalid_trigger', { reason: 'pause_not_applicable', status: s.status });
  if (isPaused(ctx)) {
    ctx.emit('SignalIgnored', { reason: 'already_paused', trigger_kind: t.kind });
    return;
  }
  const running =
    t.now === true
      ? Object.values(s.attempts)
          .filter((a) => a.status === 'running' && !a.stop_requested)
          .sort((a, b) => a.n - b.n)
      : [];
  ctx.emit('TaskPaused', {
    reason: t.reason,
    by: ctx.actor,
    at: ctx.now,
    ...(running.length === 0 ? {} : { stopped: running.map((a) => a.id) }),
  });
  for (const a of running) onStopAttempt(ctx, a.id, `paused: ${t.reason}`);
  const now = ctx.state;
  const w = now.wait;
  // Queued for the slot: hold the same resume instead; the request is withdrawn once it no longer waits.
  if (now.status === 'WAITING' && w?.detail.code === 'execution_slot') {
    waitPaused(ctx, w.resume);
    return;
  }
  // Not started yet: leave the queue, and give back a slot granted before the start.
  if (now.policy_ref === null) {
    const r = now.execution.request;
    if (r !== null)
      ctx.emit('ExecutionWithdrawn', { request_id: r.request_id, reason: 'paused', at: ctx.now });
    const h = now.execution.holding;
    if (h !== null)
      ctx.emit('ExecutionReleased', { request_id: h.request_id, reason: 'paused', at: ctx.now });
  }
}

export function onUnpause(ctx: Ctx): void {
  requireOperator(ctx);
  // Mirrors a second pause: a resume retried after a timeout has already taken effect.
  if (!isPaused(ctx)) {
    ctx.emit('SignalIgnored', { reason: 'not_paused', trigger_kind: 'unpause' });
    return;
  }
  ctx.emit('TaskUnpaused', { by: ctx.actor, at: ctx.now });
  const w = ctx.state.wait;
  if (ctx.state.status === 'WAITING' && w?.detail.code === 'paused')
    proceed(ctx, w.resume, 'unpaused');
}
