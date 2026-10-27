import { isBusinessEffect } from '../domain/effect.ts';
import { isTerminal, type EffectMirror } from '../domain/state.ts';
import { release, usageOf } from './budget.ts';
import type { Ctx } from './context.ts';
import { inFlight, requestEffect, requestReconcile } from './effects.ts';
import { closeOut } from './interpreter.ts';

/**
 * Hủy theo FR-018, trong cùng một `Decision`:
 * - effect nghiệp vụ `pending` bị vô hiệu hoá, giữ chỗ tương ứng được trả;
 * - effect `started` giữ nguyên; attempt agent đang chạy nhận effect `stop_attempt`;
 * - effect `unknown` nhận effect `reconcile`;
 * - không còn effect nào dở thì task kết thúc ngay.
 */
export function requestCancel(ctx: Ctx, reason: string): void {
  const s = ctx.state;
  if (isTerminal(s.status) || s.cancellation !== null) return;
  ctx.emit('CancelRequested', { by: ctx.actor, reason, at: ctx.now });
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
    } else if (e.status === 'unknown') {
      requestReconcile(ctx, e);
    }
  }
  maybeFinishCancel(ctx);
}

/** Vô hiệu hoá effect nghiệp vụ `pending` thoả `filter` và trả giữ chỗ (FR-018, FR-022). */
export function invalidatePending(ctx: Ctx, reason: string, filter: (e: EffectMirror) => boolean): void {
  for (const e of Object.values(ctx.state.effects)) {
    if (e.status !== 'pending' || !isBusinessEffect(e.kind) || !filter(e)) continue;
    ctx.emit('EffectInvalidated', { effect_id: e.id, reason });
    release(ctx, e.reservation_id);
    if (e.kind === 'start_agent' && e.attempt_id !== null && ctx.state.attempts[e.attempt_id]?.status === 'running') {
      ctx.emit('AttemptFinished', { attempt_id: e.attempt_id, step: e.step as string, status: 'not_started', class: null, signature: null, usage: usageOf(null) });
    }
  }
}

/**
 * Khi không còn effect `started` hay `unknown`: CANCELLED, hoặc DONE kèm `CancelRecordedLate` nếu đối
 * chiếu đã xác nhận merge thành công (FR-018).
 */
export function maybeFinishCancel(ctx: Ctx): void {
  const s = ctx.state;
  if (s.cancellation === null || isTerminal(s.status)) return;
  if (Object.values(s.effects).some(inFlight)) return;
  closeOut(ctx);
  if (s.merged) {
    const merge = Object.values(s.effects).find((e) => e.kind === 'merge' && e.status === 'succeeded');
    ctx.emit('CancelRecordedLate', { merge_effect_id: merge?.id ?? null });
    ctx.emit('TaskCompleted', { reason: 'merged_before_cancel' });
    return;
  }
  ctx.emit('TaskCancelled', { reason: s.cancellation.reason });
}
