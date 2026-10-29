import { canonicalJson } from '../shared/canonical-json.ts';
import { isTerminal, type ResumeAction, type Wait } from '../domain/state.ts';
import { taskContent, type CanonicalTask } from '../domain/task.ts';
import type { Trigger } from '../domain/trigger.ts';
import { invalidatePending, requestCancel } from './cancel.ts';
import { reject, type Ctx } from './context.ts';
import { businessInFlight } from './effects.ts';
import { cancelArmedTimers, proceed } from './interpreter.ts';
import { acceptFrozen } from './start.ts';
import { checkDependencies } from './triage.ts';

export function sameContent(a: CanonicalTask, b: CanonicalTask): boolean {
  return canonicalJson(taskContent(a)) === canonicalJson(taskContent(b));
}

/**
 * Sửa yêu cầu sau khi task đã chạy: ghi source drift ngay (FR-011). Attempt đang chạy được kết thúc; ranh
 * giới an toàn là khi không còn effect nghiệp vụ nào đang chạy hay `unknown`.
 */
export function onSourceDrift(ctx: Ctx, task: CanonicalTask): void {
  const s = ctx.state;
  const pending = s.source_drift?.task;
  if ((pending === undefined && sameContent(task, s.task)) || (pending !== undefined && sameContent(task, pending))) {
    ctx.emit('SignalIgnored', { reason: 'same_content', trigger_kind: 'source_updated' });
    return;
  }
  const next = { ...task, revision: s.revision + 1 };
  const first = s.source_drift === null;
  ctx.emit('SourceDriftDetected', { pending_revision: next.revision, task: next, at: ctx.now });
  if (!first || businessInFlight(ctx.state.effects).length > 0) return;
  // Không có gì đang chạy: ranh giới an toàn ngay. Task đang chờ thì giữ lại lý do chờ đó.
  const waiting = ctx.state.status === 'WAITING' ? ctx.state.wait : null;
  reachSafeBoundary(ctx, null, waiting);
}

/**
 * Gọi sau mỗi tín hiệu: drift chưa tới ranh giới an toàn mà không còn effect nghiệp vụ nào đang chạy hay
 * `unknown` (ví dụ đối chiếu vừa báo `not_executed` và effect về lại hàng đợi) thì đây là ranh giới; task
 * chờ người chọn revision, lý do chờ hiện có được giữ lại (FR-011).
 */
export function settleDrift(ctx: Ctx): void {
  const s = ctx.state;
  const drift = s.source_drift;
  if (drift === null || drift.safe_boundary_reached || s.cancellation !== null || isTerminal(s.status)) return;
  if (businessInFlight(s.effects).length > 0) return;
  reachSafeBoundary(ctx, null, s.status === 'WAITING' ? s.wait : null);
}

/** Việc tiếp theo bị hoãn vì source drift (gọi từ `proceed`). */
export function deferForDrift(ctx: Ctx, action: ResumeAction): void {
  if (businessInFlight(ctx.state.effects).length > 0) return;
  reachSafeBoundary(ctx, action, null);
}

/** `SafeBoundaryReached` + WAITING `human_input` `source_drift`: chờ người chọn revision (R-16). */
export function reachSafeBoundary(ctx: Ctx, deferred: ResumeAction | null, priorWait: Wait | null): void {
  const prior = priorWait?.detail['code'] === 'source_drift' ? null : priorWait;
  ctx.emit('SafeBoundaryReached', { deferred, prior_wait: prior });
  const drift = ctx.state.source_drift;
  // A runtime task froze its runtime snapshot and run selection for one revision; feature 002 has no way
  // to freeze them again for a new one, so the new requirement goes to a new task (FR-026, T063).
  const runtime = ctx.state.runtime_ref !== null;
  ctx.emit('TaskWaiting', {
    wait: {
      reason: 'human_input',
      detail: { code: 'source_drift', pending_revision: drift?.pending_revision ?? null, ...(runtime ? { apply_new: 'unsupported_for_runtime_task' } : {}) },
      resume_when: runtime ? ['drift_choice(continue_old)'] : ['drift_choice(continue_old)', 'drift_choice(apply_new)'],
      exit_paths: ['drift_choice(new_task)', 'cancel'],
      resume: { kind: 'none' },
    },
  });
}

type DriftChoice = Extract<Trigger, { kind: 'drift_choice' }>;

/** Lựa chọn của người tại ranh giới an toàn (FR-011, FR-040, research R-16). */
export function onDriftChoice(ctx: Ctx, t: DriftChoice): void {
  const s = ctx.state;
  const drift = s.source_drift;
  if (drift === null || !drift.safe_boundary_reached) reject('invalid_trigger', { reason: 'no_drift_at_safe_boundary' });

  switch (t.choice) {
    case 'continue_old': {
      ctx.emit('TaskResumed', { reason: 'drift:continue_old' });
      if (drift.prior_wait !== null) ctx.emit('TaskWaiting', { wait: drift.prior_wait });
      else proceed(ctx, drift.deferred ?? { kind: 'none' });
      return;
    }
    case 'new_task': {
      // Task mới do caller tạo bằng `create_task` có liên kết nguồn; task cũ đi theo quy trình hủy.
      invalidatePending(ctx, 'drift:new_task', () => true);
      ctx.emit('TaskResumed', { reason: 'drift:new_task' });
      requestCancel(ctx, 'drift:new_task');
      return;
    }
    case 'apply_new': {
      if (s.runtime_ref !== null) reject('invalid_trigger', { reason: 'runtime_revision_unsupported' });
      if (t.freeze === undefined) reject('invalid_trigger', { reason: 'apply_new_needs_freeze' });
      // Triage của revision mới chạy trước khi ghi gì (FR-040, FR-008): acceptance và dependency phải hợp lệ,
      // dependency phải DONE. Task đang chạy không quay về PENDING được nên lựa chọn bị từ chối.
      if (drift.task.acceptance.length === 0) reject('invalid_trigger', { reason: 'missing_acceptance' });
      checkDependencies(drift.task, ctx.related);
      const notDone = drift.task.depends_on.filter((d) => ctx.related.deps[d] !== 'DONE');
      if (notDone.length > 0) reject('dependency_invalid', { reason: 'dependency_not_done', depends_on: notDone });
      if (!t.freeze.ok) {
        // Không chốt được chính sách hay ngữ cảnh mới: không ghi gì của revision mới (FR-038).
        const wait = s.wait as Wait;
        ctx.emit('TaskWaiting', { wait: { ...wait, detail: { ...wait.detail, freeze_error: t.freeze.error.code } } });
        return;
      }
      const { policy, context } = acceptFrozen(ctx, t.freeze.value, drift.pending_revision);
      const oldRevision = s.revision;
      const oldApprovals = Object.values(s.approvals).filter((a) => a.revision === oldRevision).map((a) => a.id);
      invalidatePending(ctx, 'revision_applied', (e) => e.revision === oldRevision);
      cancelArmedTimers(ctx, true);
      ctx.emit('RevisionApplied', { revision: drift.pending_revision, task: drift.task });
      ctx.emit('PolicyFrozen', {
        policy,
        context,
        policy_hash: policy.policy_hash,
        context_hash: context.context_hash,
        structure_hash: policy.structure_hash,
      });
      ctx.policy = policy;
      ctx.emit('EvidenceInvalidated', { revision: oldRevision, approvals: oldApprovals });
      // Diff hiện có được giữ; đi lại từ Triage (FR-040). Qua `proceed` để hạn task vẫn chặn được.
      proceed(ctx, { kind: 'triage' }, 'drift:apply_new');
      return;
    }
  }
}
