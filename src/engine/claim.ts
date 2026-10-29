import { isBusinessEffect, type EffectKind } from '../domain/effect.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';

export type ClaimBlockReason =
  | 'stale_revision'
  | 'source_drift'
  | 'cancelling'
  | 'terminal'
  | 'deadline'
  | 'task_waiting'
  | 'legacy_task'
  | 'completion'
  | 'head_changed'
  | 'run_config_unconfirmed';

/** The 002 daemon only dispatches tasks that carry a runtime snapshot; 001 callers keep the old rules. */
export type ClaimOptions = { require_runtime?: boolean };

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
export function claimable(state: TaskState, effect: ClaimTarget, now: number, opts: ClaimOptions = {}): Claimability {
  // A legacy task without a runtime snapshot is read-only for the 002 daemon, service effects included.
  if (opts.require_runtime === true && state.runtime_ref === null) return { ok: false, reason: 'legacy_task' };
  if (!isBusinessEffect(effect.kind)) return { ok: true };
  // A runtime task runs only the selection the user confirmed and froze at start (M01/M02).
  if (opts.require_runtime === true && (state.run.frozen_digest === null || state.run.confirmation?.digest !== state.run.frozen_digest)) {
    return { ok: false, reason: 'run_config_unconfirmed' };
  }
  // A recorded merge proof stops all business work; only stop/reconcile/observe may run (FR-040.02).
  if (state.completion !== null) return { ok: false, reason: 'completion' };
  if (isTerminal(state.status)) return { ok: false, reason: 'terminal' };
  // An unexpected remote head blocks every business effect, publishes already enqueued included (H02).
  if (state.run.head_drift !== null) return { ok: false, reason: 'head_changed' };
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
