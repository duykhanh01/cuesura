import { isBusinessEffect, type EffectKind } from '../domain/effect.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';

export type ClaimBlockReason = 'stale_revision' | 'source_drift' | 'cancelling' | 'terminal' | 'deadline' | 'task_waiting';

export type Claimability = { ok: true } | { ok: false; reason: ClaimBlockReason };

export type ClaimTarget = { id: string; kind: EffectKind; revision: number };

/**
 * Điều kiện claim của research R-16. `Store.claimEffect` gọi hàm này trong cùng transaction với việc
 * append `EffectStarted`; effect bị chặn vẫn ở `pending`. Effect phục vụ (`stop_attempt`, `reconcile`)
 * không bao giờ bị chặn. Trạng thái `pending` của chính effect do kho kiểm.
 *
 * `now` là thời điểm claim: effect nghiệp vụ tạo trước hạn không được bắt đầu sau `deadline_at`, kể cả khi
 * timer `deadline` chưa được xử lý (FR-023).
 */
export function claimable(state: TaskState, effect: ClaimTarget, now: number): Claimability {
  if (!isBusinessEffect(effect.kind)) return { ok: true };
  if (isTerminal(state.status)) return { ok: false, reason: 'terminal' };
  if (state.cancellation !== null) return { ok: false, reason: 'cancelling' };
  if (effect.revision !== state.revision) return { ok: false, reason: 'stale_revision' };
  if (state.source_drift !== null) return { ok: false, reason: 'source_drift' };
  if (state.deadline_passed || (state.deadline_at !== null && now >= state.deadline_at)) {
    return { ok: false, reason: 'deadline' };
  }
  if (state.status === 'WAITING' && state.wait?.detail['effect_id'] !== effect.id) {
    return { ok: false, reason: 'task_waiting' };
  }
  return { ok: true };
}
