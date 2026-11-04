import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
import type { DetailCode } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { verifyContextHash, verifyPolicyHash } from '../policy/finalize.ts';
import { reject, type Ctx } from './context.ts';
import { enterStep } from './interpreter.ts';
import { acceptRuntime, slotBoundOperations } from './runtime.ts';
import { mkWait } from './waits.ts';
import { selectionDigest } from '../domain/run-config.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
import { runConfigConfirmed } from './run-config.ts';
import { modeWorkflowName } from './workflows/software-dev.ts';

/**
 * Verify task/revision identity and hashes. Later revisions must retain the repository and
 * workflow graph.
 */
export function acceptFrozen(
  ctx: Ctx,
  v: { policy: FrozenPolicy; context: FrozenExecutionContext },
  revision: number,
): { policy: FrozenPolicy; context: FrozenExecutionContext } {
  const { policy, context } = v;
  const s = ctx.state;
  if (policy.task_id !== s.id || context.task_id !== s.id)
    reject('invalid_trigger', { reason: 'freeze_task_mismatch' });
  if (policy.revision !== revision || context.revision !== revision)
    reject('invalid_trigger', { reason: 'freeze_revision_mismatch' });
  if (policy.base_sha !== context.base_sha)
    reject('invalid_trigger', { reason: 'freeze_base_mismatch' });
  if (!verifyPolicyHash(policy) || !verifyContextHash(context))
    reject('invalid_trigger', { reason: 'freeze_hash_mismatch' });
  if (ctx.policy !== null && ctx.policy.structure_hash !== policy.structure_hash)
    reject('workflow_change_forbidden');
  return v;
}

type StartTrigger = Extract<Trigger, { kind: 'start' }>;

export const FREEZE_PENDING_CODES: readonly string[] = [
  'config_invalid',
  'capability_missing',
  'run_config_unconfirmed',
  'unsupported_workflow',
  'unsupported_decision_mode',
  'no_valid_binding',
  'override_exceeds_caller',
];

/**
 * Freeze failure leaves needs_info without PolicyFrozen. Success records both snapshots in one
 * event and sets the task deadline only on the first start.
 */
export function onStart(ctx: Ctx, t: StartTrigger): void {
  const s = ctx.state;
  if (s.policy_ref !== null) {
    ctx.emit('SignalIgnored', {
      reason: 'already_started',
      trigger_kind: 'start',
    });
    return;
  }
  const retryable =
    s.status === 'PENDING' &&
    s.wait?.reason === 'needs_info' &&
    FREEZE_PENDING_CODES.includes(s.wait.detail.code);
  if (s.status !== 'READY' && !retryable)
    reject('invalid_trigger', { reason: 'not_ready', status: s.status });
  // A 002 start runs only under the execution slot granted to this task (FR-044).
  if (t.runtime !== undefined && s.execution.holding === null)
    reject('invalid_trigger', { reason: 'slot_not_held' });

  if (!t.freeze.ok) {
    const e = t.freeze.error;
    ctx.emit('TaskPending', {
      wait: mkWait('needs_info', e.code as DetailCode, {
        resume: { kind: 'none' },
        resume_when: ['start'],
        detail: { error: e },
      }),
    });
    // Nothing was spawned under the slot, so it goes back for the next task.
    const h = ctx.state.execution.holding;
    if (h !== null && slotBoundOperations(ctx.state).length === 0) {
      ctx.emit('ExecutionReleased', {
        request_id: h.request_id,
        reason: 'freeze_failed',
        at: ctx.now,
      });
    }
    return;
  }
  const { policy, context } = acceptFrozen(ctx, t.freeze.value, s.revision);
  if (t.runtime !== undefined) {
    acceptRuntime(ctx, t.runtime, policy);
    acceptRunConfig(ctx, t.runtime.run_config, policy);
  }
  if (s.status === 'PENDING') ctx.emit('TaskReady', {});
  // The runtime snapshot is committed before PolicyFrozen moves the task to RUNNING (FR-002.01).
  if (t.runtime !== undefined)
    ctx.emit('RuntimeConfigured', {
      runtime: t.runtime,
      runtime_hash: t.runtime.runtime_hash,
    });
  ctx.emit('PolicyFrozen', {
    started_at: ctx.now,
    policy,
    context,
    policy_hash: policy.policy_hash,
    context_hash: context.context_hash,
    structure_hash: policy.structure_hash,
  });
  ctx.policy = policy;
  if (ctx.state.deadline_at === null && policy.limits.max_wall_ms !== null) {
    ctx.emit('TimerArmed', {
      timer_id: ctx.nextId(),
      kind: 'deadline',
      due_at: ctx.now + policy.limits.max_wall_ms,
      payload: {},
    });
  }
  enterStep(ctx, policy.workflow.start, null);
}

/**
 * A runtime start freezes exactly the selection the user confirmed for this revision (M01/M02): same
 * digest as the current proposal and its confirmation, and the graph of that mode. Anything else is an
 * invalid start; nothing is spawned on an unconfirmed or stale selection.
 */
function acceptRunConfig(
  ctx: Ctx,
  rc: FrozenRuntimeContext['run_config'],
  policy: FrozenPolicy,
): void {
  const s = ctx.state;
  if (rc === undefined) reject('invalid_trigger', { reason: 'run_config_missing' });
  if (
    !runConfigConfirmed(s) ||
    rc.digest !== s.run.proposal?.digest ||
    rc.digest !== selectionDigest(rc.selection)
  ) {
    reject('invalid_trigger', {
      reason: 'run_config_unconfirmed',
      digest: rc.digest,
    });
  }
  if (
    rc.selection.task_id !== s.id ||
    rc.selection.revision !== s.revision ||
    rc.mode !== rc.selection.mode
  )
    reject('invalid_trigger', { reason: 'run_config_mismatch' });
  if (policy.workflow_name !== modeWorkflowName(rc.mode))
    reject('invalid_trigger', {
      reason: 'run_config_graph_mismatch',
      workflow: policy.workflow_name,
    });
}
