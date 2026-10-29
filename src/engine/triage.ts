import { canonicalJson } from '../shared/canonical-json.ts';
import type { TaskStatus, Wait } from '../domain/state.ts';
import type { CanonicalTask } from '../domain/task.ts';
import type { RelatedFacts } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { mkWait } from './waits.ts';

/**
 * Dependency phải tồn tại, không tự tham chiếu, không tạo chu trình (FR-008). Sai thì từ chối tín hiệu.
 */
export function checkDependencies(
  task: CanonicalTask,
  related: RelatedFacts,
): void {
  if (task.depends_on.includes(task.id))
    reject('dependency_invalid', { reason: 'self_reference' });
  const missing = task.depends_on.filter(
    (d) => (related.deps[d] ?? 'missing') === 'missing',
  );
  if (missing.length > 0)
    reject('dependency_invalid', { reason: 'missing', depends_on: missing });
  if (related.dependency_cycle)
    reject('dependency_invalid', { reason: 'dependency_cycle' });
}

/** Retry chỉ hợp lệ khi task nguồn đã kết thúc (FR-010). */
export function checkRetryOf(task: CanonicalTask, related: RelatedFacts): void {
  if (task.retry_of === null) return;
  const st = related.retry_of ?? 'missing';
  if (st !== 'DONE' && st !== 'FAILED' && st !== 'CANCELLED') {
    reject('invalid_trigger', {
      reason: 'retry_of_not_terminal',
      retry_of: task.retry_of,
      status: st,
    });
  }
}

/**
 * Điều kiện tới READY (FR-008): đã xác nhận nếu cần, có ít nhất một acceptance, mọi dependency DONE.
 * Trả `null` khi đủ điều kiện.
 */
export function pendingWait(
  ctx: Ctx,
  deps: Record<string, TaskStatus | 'missing'>,
): Wait | null {
  const s = ctx.state;
  if (s.needs_confirmation && !s.confirmed) {
    return mkWait('confirmation', 'needs_confirmation', {
      resume: { kind: 'triage' },
      resume_when: ['confirm_task'],
    });
  }
  if (s.task.acceptance.length === 0) {
    return mkWait('needs_info', 'missing_acceptance', {
      resume: { kind: 'triage' },
      resume_when: ['source_updated(acceptance)'],
    });
  }
  const status = s.task.depends_on.map(
    (d) => [d, deps[d] ?? 'missing'] as const,
  );
  const failed = status.filter(
    ([, st]) => st === 'FAILED' || st === 'CANCELLED' || st === 'missing',
  );
  if (failed.length > 0) {
    return mkWait('dependency', 'dependency_failed', {
      resume: { kind: 'triage' },
      resume_when: ['source_updated(depends_on)'],
      detail: { deps: Object.fromEntries(failed) },
    });
  }
  const waiting = status.filter(([, st]) => st !== 'DONE');
  if (waiting.length > 0) {
    return mkWait('dependency', 'dependency_pending', {
      resume: { kind: 'triage' },
      resume_when: waiting.map(([d]) => `dependency_status(${d}=DONE)`),
      detail: { deps: Object.fromEntries(waiting) },
    });
  }
  return null;
}

/** Xét lại điều kiện READY khi task chưa chạy; chỉ phát sự kiện khi trạng thái hay lý do chờ đổi. */
export function retriage(
  ctx: Ctx,
  deps: Record<string, TaskStatus | 'missing'>,
): void {
  const s = ctx.state;
  if (s.status !== 'PENDING' && s.status !== 'READY') return;
  const wait = pendingWait(ctx, deps);
  if (wait === null) {
    if (s.status !== 'READY') ctx.emit('TaskReady', {});
    return;
  }
  if (s.status === 'PENDING' && canonicalJson(s.wait) === canonicalJson(wait))
    return;
  ctx.emit('TaskPending', { wait });
}
