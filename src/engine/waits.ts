import type { DetailCode, ResumeAction, Wait, WaitReason } from '../domain/state.ts';
import type { Ctx } from './context.ts';
import { businessInFlight } from './effects.ts';
import { reachSafeBoundary } from './revision.ts';

/** Mọi trạng thái chờ có điều kiện tiếp tục và đường kết thúc (FR-009, SC-006). */
export function mkWait(
  reason: WaitReason,
  code: DetailCode,
  o: { resume?: ResumeAction; resume_when: string[]; exit_paths?: string[]; detail?: Record<string, unknown> },
): Wait {
  return {
    reason,
    detail: { ...o.detail, code },
    resume_when: o.resume_when,
    exit_paths: o.exit_paths ?? ['cancel'],
    resume: o.resume ?? { kind: 'none' },
  };
}

/**
 * Đưa task vào trạng thái chờ. Nếu đang có source drift chưa tới ranh giới an toàn và không còn effect
 * nghiệp vụ nào đang chạy, đây chính là ranh giới: task chờ người chọn revision, còn lý do chờ vừa có được
 * giữ lại để khôi phục khi chọn tiếp tục revision cũ (FR-011).
 */
export function waitTask(ctx: Ctx, wait: Wait): void {
  const drift = ctx.state.source_drift;
  if (drift !== null && businessInFlight(ctx.state.effects).length === 0) {
    reachSafeBoundary(ctx, drift.safe_boundary_reached ? drift.deferred : null, wait);
    return;
  }
  ctx.emit('TaskWaiting', { wait });
}

/** Chờ chính sách: hết lượt, hết thang, hết hạn… Chỉ amendment của admin mở lại (FR-023). */
export function waitPolicy(ctx: Ctx, code: DetailCode, resume: ResumeAction, detail: Record<string, unknown> = {}): void {
  waitTask(ctx, mkWait('policy', code, { resume, resume_when: ['amend'], detail }));
}

export function ensureRunning(ctx: Ctx, reason: string): void {
  if (ctx.state.status === 'WAITING') ctx.emit('TaskResumed', { reason });
}
