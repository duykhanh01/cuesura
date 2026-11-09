import { isBusinessEffect, type EffectKind } from '../domain/effect.ts';
import { cancelReadRef } from '../domain/runtime.ts';
import { isTerminal, type EffectMirror, type TaskState } from '../domain/state.ts';
import { release, usageOf } from './budget.ts';
import type { Ctx } from './context.ts';
import { inFlight, requestEffect, requestReconcile } from './effects.ts';
import { closeOut } from './interpreter.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { mkWait } from './waits.ts';

/**
 * Effects that run only local processes (setup, gates), stopped on cancel. A push, PR or rerun request
 * already sent is left to finish within its own bound: stopping it midway would only make its remote
 * effect unknown.
 */
const LOCAL_STOPPABLE: readonly EffectKind[] = ['prepare', 'run_gates'];

/**
 * Cancellation invalidates pending business effects and releases their reservations. Running
 * operations are stopped, unknown effects are reconciled, and the task ends only after all
 * outstanding work settles.
 */
export function requestCancel(ctx: Ctx, reason: string): void {
  const s = ctx.state;
  if (isTerminal(s.status) || s.cancellation !== null) return;
  ctx.emit('CancelRequested', {
    by: ctx.actor,
    reason,
    at: ctx.now,
    ...(s.runtime_ref === null ? {} : { read_token: ctx.nextId() }),
  });
  invalidatePending(ctx, 'cancelled', () => true);
  for (const e of Object.values(ctx.state.effects)) {
    if (e.status === 'started' && e.kind === 'start_agent' && e.attempt_id !== null) {
      requestEffect(ctx, {
        kind: 'stop_attempt',
        logical_id: e.attempt_id,
        step: e.step,
        attempt_id: e.attempt_id,
        target_effect_id: e.id,
        request: { attempt_id: e.attempt_id, reason },
      });
    } else if (e.status === 'started' && LOCAL_STOPPABLE.includes(e.kind)) {
      // Setup and gate processes are stopped too (FR-025.02); the effect then goes to reconcile.
      requestEffect(ctx, {
        kind: 'stop_attempt',
        logical_id: `stop:${e.id}`,
        step: e.step,
        attempt_id: null,
        target_effect_id: e.id,
        request: { effect_id: e.id, reason },
      });
    } else if (e.status === 'unknown') {
      requestReconcile(ctx, e);
    }
  }
  maybeFinishCancel(ctx);
}

export function invalidatePending(
  ctx: Ctx,
  reason: string,
  filter: (e: EffectMirror) => boolean,
): void {
  for (const e of Object.values(ctx.state.effects)) {
    if (e.status !== 'pending' || !isBusinessEffect(e.kind) || !filter(e)) continue;
    ctx.emit('EffectInvalidated', { effect_id: e.id, reason });
    release(ctx, e.reservation_id);
    if (
      e.kind === 'start_agent' &&
      e.attempt_id !== null &&
      ctx.state.attempts[e.attempt_id]?.status === 'running'
    ) {
      ctx.emit('AttemptFinished', {
        attempt_id: e.attempt_id,
        step: e.step as string,
        status: 'not_started',
        class: null,
        signature: null,
        usage: usageOf(null),
      });
    }
  }
}

/** A confirmed merge remains DONE even when cancellation was requested before reconciliation. */
export function maybeFinishCancel(ctx: Ctx): void {
  const s = ctx.state;
  if (s.cancellation === null || isTerminal(s.status)) return;
  // Once a merge proof is recorded the drain decides; the cancel is recorded late on DONE.
  if (s.completion !== null) return;
  if (Object.values(s.effects).some(inFlight)) return;
  if (cancelNeedsPrRead(s)) {
    waitCancelReconcile(ctx);
    return;
  }
  closeOut(ctx);
  if (s.merged) {
    const merge = Object.values(s.effects).find(
      (e) => e.kind === 'merge' && e.status === 'succeeded',
    );
    ctx.emit('CancelRecordedLate', { merge_effect_id: merge?.id ?? null });
    ctx.emit('TaskCompleted', { reason: 'merged_before_cancel' });
    return;
  }
  ctx.emit('TaskCancelled', { reason: s.cancellation.reason });
}

/**
 * A runtime task with a PR ends CANCELLED only after a read of that PR requested for this cancel showed
 * it open or closed (FR-025.03). The read is bound to the cancel by its token, issued in the same accept
 * as the request, never by comparing clocks: a read made before the cancel, or by the automatic schedule,
 * does not count however its timestamps fall. A merge shown with its proof goes through the drain to DONE;
 * a merge without proof or an unreadable PR keeps the task waiting, never assumed not merged. A cancel
 * recorded before tokens existed keeps its old rule (no read).
 */
export function cancelNeedsPrRead(s: TaskState): boolean {
  const c = s.cancellation;
  if (s.runtime_ref === null || s.pr_ref === null || c === null) return false;
  if (c.read_token === undefined) return false;
  // A merge was shown, or its evidence is incomplete or contradicts: wait for reconciliation, whatever
  // any read said before or after (FR-040.12).
  if (c.merge_seen !== undefined || s.blockers.some((b) => b.code === 'merge_evidence_incomplete'))
    return true;
  if (c.forced !== undefined) return false;
  const r = c.pr_read;
  if (r === undefined) return true;
  // A PR GitHub moved to another base (its base branch deleted after a merge, #179) cannot be merged
  // into the task's target by this PR any more: for the cancel that is as final as closed.
  return !(r.status === 'open' || r.status === 'closed' || r.target !== undefined);
}

/**
 * `cancel --force` (#179): a person ends a cancel that a read of the PR could not settle, for a PR read
 * that keeps coming back unknown. It waives only that read. A merge shown or with incomplete evidence
 * still holds the cancel (FR-025.04, FR-040.12), and effects still in flight still settle first.
 */
export function forceCancel(ctx: Ctx): void {
  const s = ctx.state;
  const c = s.cancellation;
  const ignored = (reason: string): void =>
    ctx.emit('SignalIgnored', { reason, trigger_kind: 'cancel' });
  if (c === null) return;
  if (c.forced !== undefined) return ignored('already_forced');
  if (c.merge_seen !== undefined || s.blockers.some((b) => b.code === 'merge_evidence_incomplete'))
    return ignored('merge_seen');
  if (!cancelNeedsPrRead(s)) return ignored('nothing_to_force');
  ctx.emit('CancelForced', { by: ctx.actor, at: ctx.now });
  maybeFinishCancel(ctx);
}

/** A read for the open cancel that gave no observation; counted so the backoff and the person see it. */
export function onCancelReadFailed(ctx: Ctx, token: string, detail: string): void {
  const s = ctx.state;
  if (isTerminal(s.status) || s.cancellation?.read_token !== token || !cancelNeedsPrRead(s)) {
    ctx.emit('SignalIgnored', { reason: 'stale_cancel_read', trigger_kind: 'cancel_read_failed' });
    return;
  }
  ctx.emit('CancelReadFailed', { detail });
  maybeFinishCancel(ctx);
}

/** The evidence ref a read for the task's open cancel must carry; null when no read is asked for. */
export function cancelReadEvidence(s: TaskState): string | null {
  const t = s.cancellation?.read_token;
  return t === undefined || !cancelNeedsPrRead(s) ? null : cancelReadRef(t);
}

function waitCancelReconcile(ctx: Ctx): void {
  const s = ctx.state;
  const read = s.cancellation?.pr_read ?? null;
  // Waiting already: shown again only when another cancel read came back, so its outcome is visible.
  if (
    s.status === 'WAITING' &&
    s.wait?.detail.code === 'cancel_reconcile' &&
    canonicalJson(s.wait.detail['last_cancel_read'] ?? null) === canonicalJson(read) &&
    s.wait.detail['cancel_reads'] === (s.cancellation?.reads ?? 0)
  )
    return;
  ctx.emit('TaskWaiting', {
    wait: mkWait('policy', 'cancel_reconcile', {
      resume_when: ['observation(after cancel)', 'recheck(observation)'],
      exit_paths: ['recheck', 'merge the PR on GitHub, then recheck', 'cancel --force'],
      detail: {
        pr_ref: s.pr_ref,
        head_sha: s.head_sha,
        requested_at: s.cancellation?.requested_at ?? null,
        last_cancel_read: read,
        cancel_reads: s.cancellation?.reads ?? 0,
      },
    }),
  });
}
