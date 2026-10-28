import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
import type { DetailCode } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { verifyContextHash, verifyPolicyHash } from '../policy/finalize.ts';
import { reject, type Ctx } from './context.ts';
import { enterStep } from './interpreter.ts';
import { acceptRuntime } from './runtime.ts';
import { mkWait } from './waits.ts';

/**
 * Kiểm kết quả `freeze` mang trong tín hiệu: đúng task, đúng revision, hash tự kiểm; revision sau không
 * được đổi graph workflow (FR-040: cùng repo và workflow).
 */
export function acceptFrozen(
  ctx: Ctx,
  v: { policy: FrozenPolicy; context: FrozenExecutionContext },
  revision: number,
): { policy: FrozenPolicy; context: FrozenExecutionContext } {
  const { policy, context } = v;
  const s = ctx.state;
  if (policy.task_id !== s.id || context.task_id !== s.id) reject('invalid_trigger', { reason: 'freeze_task_mismatch' });
  if (policy.revision !== revision || context.revision !== revision) reject('invalid_trigger', { reason: 'freeze_revision_mismatch' });
  if (policy.base_sha !== context.base_sha) reject('invalid_trigger', { reason: 'freeze_base_mismatch' });
  if (!verifyPolicyHash(policy) || !verifyContextHash(context)) reject('invalid_trigger', { reason: 'freeze_hash_mismatch' });
  if (ctx.policy !== null && ctx.policy.structure_hash !== policy.structure_hash) reject('workflow_change_forbidden');
  return v;
}

type StartTrigger = Extract<Trigger, { kind: 'start' }>;

/** Lỗi chốt mà task có thể chờ để sửa (research R-13): PENDING `needs_info`. */
const FREEZE_PENDING_CODES: readonly string[] = [
  'config_invalid',
  'unsupported_workflow',
  'unsupported_decision_mode',
  'no_valid_binding',
  'override_exceeds_caller',
];

/**
 * Tín hiệu `start`: lỗi `freeze` → PENDING `needs_info` với `detail.code` theo R-13 và không có
 * `PolicyFrozen` (FR-038). Thành công → một `PolicyFrozen` chứa cả chính sách và ngữ cảnh, đặt
 * `deadline_at` lần đầu kèm timer `deadline` (R-22), rồi vào bước đầu của workflow.
 */
export function onStart(ctx: Ctx, t: StartTrigger): void {
  const s = ctx.state;
  if (s.policy_ref !== null) {
    ctx.emit('SignalIgnored', { reason: 'already_started', trigger_kind: 'start' });
    return;
  }
  const retryable = s.status === 'PENDING' && s.wait?.reason === 'needs_info' && FREEZE_PENDING_CODES.includes(s.wait.detail.code);
  if (s.status !== 'READY' && !retryable) reject('invalid_trigger', { reason: 'not_ready', status: s.status });

  if (!t.freeze.ok) {
    const e = t.freeze.error;
    ctx.emit('TaskPending', {
      wait: mkWait('needs_info', e.code as DetailCode, {
        resume: { kind: 'none' },
        resume_when: ['start'],
        detail: { error: e },
      }),
    });
    return;
  }
  const { policy, context } = acceptFrozen(ctx, t.freeze.value, s.revision);
  if (t.runtime !== undefined) acceptRuntime(ctx, t.runtime, policy);
  if (s.status === 'PENDING') ctx.emit('TaskReady', {});
  // The runtime snapshot is committed before PolicyFrozen moves the task to RUNNING (FR-002.01).
  if (t.runtime !== undefined) ctx.emit('RuntimeConfigured', { runtime: t.runtime, runtime_hash: t.runtime.runtime_hash });
  ctx.emit('PolicyFrozen', {
    policy,
    context,
    policy_hash: policy.policy_hash,
    context_hash: context.context_hash,
    structure_hash: policy.structure_hash,
  });
  ctx.policy = policy;
  if (ctx.state.deadline_at === null) {
    ctx.emit('TimerArmed', { timer_id: ctx.nextId(), kind: 'deadline', due_at: ctx.now + policy.limits.max_wall_ms, payload: {} });
  }
  enterStep(ctx, policy.workflow.start, null);
}

