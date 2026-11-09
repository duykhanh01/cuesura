import { DEFAULT_RUNTIME_LIMITS } from '../domain/runtime.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { inFlight, requestEffect, requestReconcile } from './effects.ts';
import { closeOut } from './interpreter.ts';
import { isUnresolved } from './runtime.ts';

/**
 * Drain after a merge proof (T046, FR-040.04–09/13). Only work already sent is dealt with: running agent
 * attempts get `stop_attempt`, effects whose outcome is unknown get `reconcile`, and a push already sent
 * may still land and is recorded as it is, without proceeding or retrying. Nothing new is started, local
 * changes stay in the worktree, and each round records what it still holds (local remainder).
 * TaskCompleted is written exactly once, together with DrainFinished, and only when no effect is in
 * flight and no operation is unresolved; until then the task waits as
 * merge_cleanup_pending and keeps its claims. The drain is bounded (default 5 minutes, 3 rounds); past
 * either it pauses and only a recheck resumes it.
 */

export const DRAIN_MAX_MS = DEFAULT_RUNTIME_LIMITS.drain_max_ms;
export const DRAIN_MAX_ROUNDS = DEFAULT_RUNTIME_LIMITS.drain_max_rounds;

/** Effects in flight and operations whose end is not proven: what still holds the task open. */
export function drainPending(s: TaskState): string[] {
  const effects = Object.values(s.effects)
    .filter(inFlight)
    .map((e) => `effect:${e.id}`);
  const ops = Object.values(s.operations)
    .filter(isUnresolved)
    .map((o) => `operation:${o.id}`);
  return [...effects, ...ops].sort();
}

/** Starts the drain right after the proof is recorded. */
export function startDrain(ctx: Ctx): void {
  for (const e of Object.values(ctx.state.effects)) {
    if (e.status === 'started' && e.kind === 'start_agent' && e.attempt_id !== null) {
      requestEffect(ctx, {
        kind: 'stop_attempt',
        logical_id: e.attempt_id,
        step: e.step,
        attempt_id: e.attempt_id,
        target_effect_id: e.id,
        request: { attempt_id: e.attempt_id, reason: 'merged' },
      });
    } else if (e.status === 'unknown') {
      requestReconcile(ctx, e);
    }
  }
  ctx.emit('DrainStarted', {
    at: ctx.now,
    deadline_at: ctx.now + DRAIN_MAX_MS,
    max_rounds: DRAIN_MAX_ROUNDS,
    pending_operations: Object.values(ctx.state.operations)
      .filter(isUnresolved)
      .map((o) => o.id)
      .sort(),
  });
  settleCompletion(ctx);
}

/**
 * Runs after every decision on a task with a merge proof: finishes the drain once nothing is pending.
 * A cancel that arrived after the merge is recorded as late; the task still ends DONE.
 */
export function settleCompletion(ctx: Ctx): void {
  const s = ctx.state;
  if (
    s.completion === null ||
    s.completion.finalized_at !== null ||
    isTerminal(s.status) ||
    s.completion.drain.started_at === null
  )
    return;
  if (drainPending(s).length > 0) return;
  ctx.emit('DrainFinished', { at: ctx.now });
  closeOut(ctx);
  if (ctx.state.cancellation !== null) ctx.emit('CancelRecordedLate', { merge_effect_id: null });
  ctx.emit('TaskCompleted', {
    reason:
      ctx.state.completion?.unverified === null
        ? 'external_confirmation'
        : 'external_confirmation_unverified',
  });
}

type DrainResult = Extract<Trigger, { kind: 'drain_result' }>;

/** One drain round reported by the daemon; past the round or time cap the drain pauses. */
export function onDrainResult(ctx: Ctx, t: DrainResult): void {
  const c = ctx.state.completion;
  if (c === null) reject('invalid_trigger', { reason: 'no_completion' });
  if (c.finalized_at !== null) {
    ctx.emit('SignalIgnored', {
      reason: 'drain_finished',
      trigger_kind: t.kind,
    });
    return;
  }
  if (c.drain.paused) {
    ctx.emit('SignalIgnored', { reason: 'drain_paused', trigger_kind: t.kind });
    return;
  }
  const round = c.drain.count + 1;
  ctx.emit('DrainProgressed', {
    at: ctx.now,
    round,
    pending_operations: [...t.pending_operations].sort(),
    // The worktree as the round found it: recorded, never cleaned up to match the merge (FR-040.06).
    ...(t.local === undefined ? {} : { local: { ...t.local, observed_at: ctx.now } }),
  });
  settleCompletion(ctx);
  const after = ctx.state.completion;
  if (after === null || after.finalized_at !== null) return;
  if (round >= after.drain.max_rounds)
    ctx.emit('DrainPaused', { at: ctx.now, reason: 'round_limit' });
  else if (after.drain.deadline_at !== null && ctx.now >= after.drain.deadline_at)
    ctx.emit('DrainPaused', { at: ctx.now, reason: 'deadline' });
}
