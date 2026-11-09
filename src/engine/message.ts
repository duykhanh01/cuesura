import { hasRole } from '../domain/policy.ts';
import type { Attempt, MessageBehavior, ResumeAction } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { onStopAttempt } from './decide.ts';
import { isPaused } from './pause.ts';

/**
 * `cusr task message` (issue #154), modelled on how paseo delivers a prompt to a busy agent: `interrupt`
 * cancels the running turn and starts a new turn with the message; `steer` injects it into the running
 * turn and falls back to `interrupt` when the provider cannot take input mid-turn. A Cuesura worker runs
 * under its own runner with a fixed stdin file, and `codex exec` reads no input once started, so `steer`
 * always falls back here. The new turn continues the interrupted session when the harness can resume it,
 * else starts a new session; either way its context carries every message of the revision, like answers.
 *
 * Only running coder/fixer turns are interrupted. A reviewer always starts from its own packet and
 * finishes; a paused task interrupts nothing and a stopped turn waits for the resume; `queue` waits for
 * the next turn. The interrupted turn still counts against the agent-run budget.
 */

type MessageTrigger = Extract<Trigger, { kind: 'message' }>;

/** Whether a message interrupted this attempt, so its end continues the session with the message. */
export function stoppedByMessage(ctx: Pick<Ctx, 'state'>, attemptId: string): boolean {
  return ctx.state.message_stops?.includes(attemptId) ?? false;
}

/**
 * What runs once an attempt a message interrupted has ended: the same step again, resuming its session.
 * The single conflict fixer of a base update goes through the fixer retry, which hands the one attempt
 * to the continuation instead of waiting for a manual repair.
 */
export function afterMessageStop(ctx: Pick<Ctx, 'state'>, a: Attempt): ResumeAction {
  const u = ctx.state.run.base_update;
  if (u?.fixer_attempt_id === a.id && u.certificate === undefined)
    return { kind: 'repair_base', mode: 'retry_fixer' };
  return { kind: 'start_attempt', step: a.step, attempt_kind: 'retry' };
}

export function onMessage(ctx: Ctx, t: MessageTrigger): void {
  if (!hasRole(ctx.env.authz, 'operate') && !hasRole(ctx.env.authz, 'admin'))
    reject('invalid_trigger', { reason: 'operate_required' });
  const s = ctx.state;
  if (s.completion !== null || s.cancellation !== null)
    reject('invalid_trigger', { reason: 'message_not_applicable', status: s.status });
  // paseo's default: an agent caller steers, a person interrupts.
  const behavior: MessageBehavior =
    t.behavior ?? (ctx.actor === 'assistant' ? 'steer' : 'interrupt');
  const running =
    behavior === 'queue' || isPaused(ctx)
      ? []
      : Object.values(s.attempts)
          .filter((a) => {
            const role = ctx.frozen.steps[a.step]?.role;
            return (
              a.status === 'running' &&
              !a.stop_requested &&
              a.revision === s.revision &&
              (role === 'coder' || role === 'fixer')
            );
          })
          .sort((a, b) => a.n - b.n);
  ctx.emit('TaskMessageSent', {
    message_id: ctx.nextId(),
    body: t.body,
    by: ctx.actor,
    at: ctx.now,
    revision: s.revision,
    behavior,
    delivery: running.length === 0 ? 'next_turn' : 'interrupt',
    ...(running.length === 0 ? {} : { stopped: running.map((a) => a.id) }),
    ...(behavior === 'steer' && running.length > 0 ? { fallback: 'steer_unsupported' } : {}),
  });
  for (const a of running) onStopAttempt(ctx, a.id, 'message');
}
