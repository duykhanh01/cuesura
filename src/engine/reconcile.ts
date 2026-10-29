import { isRequeueSafe } from '../domain/effect.ts';
import type { EffectMirror } from '../domain/state.ts';
import {
  AgentDataSchema,
  FailureDataSchema,
  ReviewDataSchema,
  type Trigger,
} from '../domain/trigger.ts';
import { release, usageOf } from './budget.ts';
import { reject, type Ctx } from './context.ts';
import {
  onEffectFailed,
  onEffectSucceeded,
  parseSuccess,
  proceed,
} from './interpreter.ts';

type Reconciled = Extract<Trigger, { kind: 'effect_reconciled' }>;

/** Effect `reconcile` đã yêu cầu cho effect gốc cũng xong cùng lúc. */
function closeProbe(ctx: Ctx, target: EffectMirror, result: unknown): void {
  for (const e of Object.values(ctx.state.effects)) {
    if (
      e.kind === 'reconcile' &&
      e.target_effect_id === target.id &&
      (e.status === 'pending' || e.status === 'started')
    ) {
      ctx.emit('EffectCompleted', {
        effect_id: e.id,
        status: 'succeeded',
        result,
      });
    }
  }
}

/**
 * Dữ liệu chuẩn bắt buộc cho `executed_succeeded` (R-17). Với `start_agent`: output đã kiểm tra schema,
 * có `invoked` và usage có nhãn; chỉ exit code thì chưa đủ.
 */
function successIssues(ctx: Ctx, e: EffectMirror, data: unknown): string[] {
  if (data === undefined) return ['thiếu data'];
  const parsed = parseSuccess(ctx, e, data);
  if (!parsed.ok) return parsed.issues;
  if (e.kind === 'start_agent') {
    const d = (
      ctx.frozen.workflow.steps[e.step ?? '']?.kind === 'review'
        ? ReviewDataSchema
        : AgentDataSchema
    ).parse(data);
    const issues: string[] = [];
    if (!d.schema_checked)
      issues.push('schema_checked: output chưa kiểm tra schema');
    if (d.invoked === undefined) issues.push('invoked: thiếu');
    return issues;
  }
  return [];
}

/** Tín hiệu `effect_reconciled` theo bảng "Kết quả đối chiếu" (contracts/signals-events.md). */
export function onReconciled(ctx: Ctx, t: Reconciled): void {
  const e = ctx.state.effects[t.effect_id];
  if (e === undefined)
    reject('invalid_trigger', {
      reason: 'unknown_effect',
      effect_id: t.effect_id,
    });
  if (e.status !== 'unknown' && e.status !== 'started') {
    ctx.emit('SignalIgnored', {
      reason: `effect_${e.status}`,
      trigger_kind: t.kind,
      detail: { effect_id: e.id },
    });
    return;
  }
  switch (t.finding) {
    case 'executed_succeeded': {
      const issues = successIssues(ctx, e, t.data);
      if (issues.length > 0) {
        ctx.emit('ReconcileIncomplete', { effect_id: e.id, issues });
        return;
      }
      const data = (parseSuccess(ctx, e, t.data) as { ok: true; data: unknown })
        .data;
      ctx.emit('EffectReconciled', {
        effect_id: e.id,
        finding: t.finding,
        status: 'succeeded',
        result: data,
      });
      closeProbe(ctx, e, { finding: t.finding });
      // After a merge proof the finding is recorded as it is; nothing proceeds from it (FR-040.05).
      if (ctx.state.completion !== null) return;
      onEffectSucceeded(ctx, e, data);
      return;
    }
    case 'executed_failed': {
      if (
        t.failure_class === undefined ||
        (t.failure_class === 'quality' && t.signature === undefined)
      ) {
        ctx.emit('ReconcileIncomplete', {
          effect_id: e.id,
          issues: [
            t.failure_class === undefined
              ? 'failure_class: thiếu'
              : 'signature: lớp quality cần chữ ký',
          ],
        });
        return;
      }
      const f = FailureDataSchema.parse({
        failure_class: t.failure_class,
        ...(t.signature !== undefined ? { signature: t.signature } : {}),
      });
      ctx.emit('EffectReconciled', {
        effect_id: e.id,
        finding: t.finding,
        status: 'failed',
        result: f,
      });
      closeProbe(ctx, e, { finding: t.finding });
      if (ctx.state.completion !== null) return;
      onEffectFailed(ctx, e, f);
      return;
    }
    case 'not_executed': {
      // Chắc chắn chưa chạy: trả giữ chỗ. Chỉ effect chạy lại an toàn mới về hàng đợi với cùng `idem_key`.
      release(ctx, e.reservation_id);
      const requeue =
        isRequeueSafe(e.kind) &&
        ctx.state.cancellation === null &&
        ctx.state.completion === null &&
        e.revision === ctx.state.revision;
      ctx.emit('EffectReconciled', {
        effect_id: e.id,
        finding: t.finding,
        status: requeue ? 'pending' : 'failed',
        result: null,
      });
      closeProbe(ctx, e, { finding: t.finding });
      if (
        ctx.state.status === 'WAITING' &&
        ctx.state.wait?.detail['effect_id'] === e.id
      ) {
        ctx.emit('TaskResumed', { reason: `effect:${e.id}` });
      }
      if (requeue || e.kind !== 'start_agent' || e.attempt_id === null) {
        proceed(ctx, { kind: 'none' });
        return;
      }
      ctx.emit('AttemptFinished', {
        attempt_id: e.attempt_id,
        step: e.step as string,
        status: 'not_executed',
        class: null,
        signature: null,
        usage: usageOf(null),
      });
      const attempt = ctx.state.attempts[e.attempt_id];
      if (
        ctx.state.cancellation !== null ||
        attempt === undefined ||
        attempt.stop_requested ||
        ctx.state.current_attempt[attempt.step] !== attempt.id
      ) {
        proceed(ctx, { kind: 'none' });
        return;
      }
      // Attempt mới có ID mới nên có khoá mới (FR-016).
      proceed(ctx, {
        kind: 'start_attempt',
        step: attempt.step,
        attempt_kind: 'retry',
      });
      return;
    }
    case 'still_unknown':
      ctx.emit('EffectReconciled', {
        effect_id: e.id,
        finding: t.finding,
        status: e.status === 'started' ? 'unknown' : e.status,
        result: null,
      });
      return;
  }
}
