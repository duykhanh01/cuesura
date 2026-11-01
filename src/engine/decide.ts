import { assertNever } from '../shared/assert-never.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { DomainEventDraft } from '../domain/event.ts';
import { hasRole, type FrozenPolicy } from '../domain/policy.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';
import type {
  RelatedFacts,
  Trigger,
  TriggerEnvelope,
} from '../domain/trigger.ts';
import { verifyPolicyHash } from '../policy/finalize.ts';
import {
  invalidatePending,
  maybeFinishCancel,
  requestCancel,
} from './cancel.ts';
import { Ctx, reject, Rejection, type RejectCode } from './context.ts';
import { requestEffect, requestReconcile } from './effects.ts';
import { IdPoolExhausted } from './ids.ts';
import {
  onConfigChecked,
  onDependencyStatus,
  onConfirmTask,
  onCreateTask,
  onSourceUpdated,
} from './intake.ts';
import { onDrainResult, settleCompletion } from './drain.ts';
import { onExternalCompletion } from './external-completion.ts';
import { onObservationDue, onObservationResult } from './observation.ts';
import { onEffectResult, proceed } from './interpreter.ts';
import { askHuman, onAnswer, onApprovalDecision } from './questions.ts';
import { onReconciled } from './reconcile.ts';
import { onDriftChoice, settleDrift } from './revision.ts';
import {
  onGrantExecution,
  onIngestRecord,
  onOperationResult,
  onReleaseExecution,
  onRequestExecution,
  settleSlot,
} from './runtime.ts';
import { onStart } from './start.ts';
import { onRecheck } from './recheck.ts';
import { waitPolicy } from './waits.ts';
import { onHeadDrift } from './head-drift.ts';
import { onConfirmRunConfig, onProposeRunConfig } from './run-config.ts';

export type DecideInput = {
  state: TaskState | null;

  policy: FrozenPolicy | null;
  envelope: TriggerEnvelope;

  related: RelatedFacts;
};

export type Decision =
  | { kind: 'accepted'; events: DomainEventDraft[] }
  | { kind: 'rejected'; code: RejectCode; detail?: unknown };

export type { RejectCode };

/**
 * Pure decision core: time and IDs come from the envelope. Identical inputs produce identical
 * canonical JSON.
 */
export function decide(input: DecideInput): Decision {
  const ctx = new Ctx(input.state, input.policy, input.envelope, input.related);
  try {
    dispatch(ctx, input.envelope.trigger);
    if (ctx.hasState) {
      settleDrift(ctx);
      settleCompletion(ctx);
      settleSlot(ctx);
    }
  } catch (e) {
    if (e instanceof Rejection)
      return e.detail === undefined
        ? { kind: 'rejected', code: e.code }
        : { kind: 'rejected', code: e.code, detail: e.detail };
    if (e instanceof IdPoolExhausted)
      return { kind: 'rejected', code: 'id_pool_exhausted' };
    throw e;
  }
  return { kind: 'accepted', events: ctx.events };
}

const AFTER_TERMINAL: readonly Trigger['kind'][] = [
  'operation_result',
  'ingest_record',
  'release_execution',
];

function dispatch(ctx: Ctx, t: Trigger): void {
  if (t.kind === 'create_task') {
    onCreateTask(ctx, t);
    return;
  }
  if (!ctx.hasState) reject('unknown_task');
  if (ctx.state.id !== ctx.env.task_id)
    reject('invalid_trigger', { reason: 'task_id_mismatch' });
  // Reject amendments without admin authorization before emitting any events.
  if (t.kind === 'amend' && !hasRole(ctx.env.authz, 'admin'))
    reject('not_admin');
  // Terminal tasks still accept outstanding operation receipts and releases so they cannot retain a slot forever.

  if (isTerminal(ctx.state.status) && !AFTER_TERMINAL.includes(t.kind)) {
    ctx.emit('SignalIgnored', { reason: 'terminal', trigger_kind: t.kind });
    return;
  }
  const needsPolicy = ![
    'confirm_task',
    'config_checked',
    'source_updated',
    'dependency_status',
    'start',
    'cancel',
    'request_execution',
    'grant_execution',
    'release_execution',
    'operation_result',
    'ingest_record',
    'propose_run_config',
    'confirm_run_config',
    'recheck',
  ].includes(t.kind);
  if (needsPolicy && (ctx.policy === null || ctx.state.policy_ref === null))
    reject('invalid_trigger', { reason: 'not_started' });

  switch (t.kind) {
    case 'confirm_task':
      onConfirmTask(ctx);
      return;
    case 'config_checked':
      onConfigChecked(ctx, t);
      return;
    case 'source_updated':
      onSourceUpdated(ctx, t);
      return;
    case 'dependency_status':
      onDependencyStatus(ctx, t);
      return;
    case 'start':
      onStart(ctx, t);
      return;
    case 'effect_result':
      onEffectResult(ctx, t);
      maybeFinishCancel(ctx);
      return;
    case 'effect_reconciled':
      onReconciled(ctx, t);
      maybeFinishCancel(ctx);
      return;
    case 'timer':
      onTimer(ctx, t.timer_id);
      return;
    case 'answer':
      onAnswer(ctx, t);
      return;
    case 'approve':
    case 'reject':
      onApprovalDecision(ctx, t);
      return;
    case 'drift_choice':
      onDriftChoice(ctx, t);
      return;
    case 'stop_attempt':
      onStopAttempt(ctx, t.attempt_id, t.reason);
      return;
    case 'cancel':
      if (ctx.state.cancellation !== null) {
        ctx.emit('SignalIgnored', {
          reason: 'already_cancelling',
          trigger_kind: t.kind,
        });
        return;
      }
      requestCancel(ctx, t.reason);
      return;
    case 'amend':
      onAmend(ctx, t);
      return;
    case 'request_execution':
      onRequestExecution(ctx);
      return;
    case 'grant_execution':
      onGrantExecution(ctx, t);
      return;
    case 'release_execution':
      onReleaseExecution(ctx, t);
      return;
    case 'operation_result':
      onOperationResult(ctx, t);
      return;
    case 'ingest_record':
      onIngestRecord(ctx, t);
      return;
    case 'external_completion':
      onExternalCompletion(ctx, t);
      return;
    case 'observation_result':
      onObservationResult(ctx, t);
      maybeFinishCancel(ctx);
      return;
    case 'drain_result':
      onDrainResult(ctx, t);
      return;
    case 'propose_run_config':
      onProposeRunConfig(ctx, t);
      return;
    case 'confirm_run_config':
      onConfirmRunConfig(ctx, t);
      return;
    case 'head_drift':
      onHeadDrift(ctx, t);
      return;
    case 'observation_due':
      onObservationDue(ctx, t);
      return;
    case 'recheck':
      onRecheck(ctx, t);
      return;
    default:
      assertNever(t);
  }
}

function onTimer(ctx: Ctx, timerId: string): void {
  const timer = ctx.state.timers[timerId];
  if (timer === undefined)
    reject('invalid_trigger', { reason: 'unknown_timer', timer_id: timerId });
  if (timer.status !== 'armed') {
    ctx.emit('SignalIgnored', {
      reason: `timer_${timer.status}`,
      trigger_kind: 'timer',
      detail: { timer_id: timerId },
    });
    return;
  }
  ctx.emit('TimerFired', { timer_id: timerId });
  const s = ctx.state;
  switch (timer.kind) {
    case 'deadline': {
      // Do not nest a deadline wait if the trigger time already caused one before the timer fired.
      if (
        s.cancellation !== null ||
        (s.wait?.reason === 'policy' && s.wait.detail.code === 'deadline')
      )
        return;
      // Retain deferred work so an admin deadline extension can resume it.
      const resume =
        s.status === 'WAITING'
          ? (s.wait?.resume ?? { kind: 'none' })
          : { kind: 'none' as const };
      const prior = s.status === 'WAITING' ? s.wait : null;
      waitPolicy(ctx, 'deadline', resume, {
        deadline_at: s.deadline_at,
        ...(prior !== null ? { prior_wait: prior } : {}),
      });
      return;
    }
    case 'ci_poll':
    case 'ci_timeout':
    case 'backoff': {
      const waitingOnThis =
        s.status === 'WAITING' && s.wait?.detail['timer_id'] === timerId;
      if (waitingOnThis && timer.payload.resume !== undefined)
        proceed(ctx, timer.payload.resume, `timer:${timerId}`);
      return;
    }
    default:
      assertNever(timer.kind);
  }
}

/**
 * Stopping one attempt invalidates pending launches or requests a stop for a running one. A later
 * result from the stopped attempt must not advance the workflow.
 */
function onStopAttempt(ctx: Ctx, attemptId: string, reason: string): void {
  const s = ctx.state;
  const a = s.attempts[attemptId];
  if (a === undefined)
    reject('invalid_trigger', {
      reason: 'unknown_attempt',
      attempt_id: attemptId,
    });
  if (a.status !== 'running' || a.stop_requested) {
    ctx.emit('SignalIgnored', {
      reason: 'stale_attempt',
      trigger_kind: 'stop_attempt',
      detail: { attempt_id: attemptId },
    });
    return;
  }
  const e = s.effects[a.effect_id];
  if (e === undefined) throw new Error(`Attempt ${attemptId} has no effect`);
  if (e.status === 'pending') {
    invalidatePending(ctx, 'attempt_stopped', (x) => x.id === e.id);
    askHuman(ctx, 'attempt_stopped', {
      step: a.step,
      attempt_id: a.id,
      body: `Attempt ${a.n} of step '${a.step}' stopped before execution: ${reason}`,
      resume: {
        kind: 'start_attempt',
        step: a.step,
        attempt_kind: 'fresh_session',
      },
    });
    return;
  }
  requestEffect(ctx, {
    kind: 'stop_attempt',
    logical_id: a.id,
    step: a.step,
    attempt_id: a.id,
    target_effect_id: e.id,
    request: { attempt_id: a.id, reason },
  });
  if (e.status === 'unknown') requestReconcile(ctx, e);
}

type AmendTrigger = Extract<Trigger, { kind: 'amend' }>;

/**
 * Amendments require the same task/revision, version + 1, a valid hash, and an unchanged workflow
 * graph.
 */
function onAmend(ctx: Ctx, t: AmendTrigger): void {
  const cur = ctx.frozen;
  const next = t.policy;
  if (next.task_id !== cur.task_id || next.revision !== cur.revision)
    reject('invalid_trigger', { reason: 'amend_target_mismatch' });
  if (
    next.structure_hash !== cur.structure_hash ||
    canonicalJson(next.workflow) !== canonicalJson(cur.workflow)
  ) {
    reject('workflow_change_forbidden');
  }
  if (next.policy_version !== cur.policy_version + 1)
    reject('invalid_trigger', { reason: 'policy_version' });
  if (!verifyPolicyHash(next))
    reject('invalid_trigger', { reason: 'policy_hash' });

  ctx.emit('PolicyAmended', {
    policy: next,
    diff: t.diff,
    reason: t.reason,
    by: ctx.actor,
    policy_hash: next.policy_hash,
    policy_version: next.policy_version,
  });
  ctx.policy = next;

  const s = ctx.state;
  // Recompute an extended deadline from the original start time, not from the amendment time.
  if (next.limits.max_wall_ms !== cur.limits.max_wall_ms) {
    const started =
      s.started_at ??
      (s.deadline_at !== null && cur.limits.max_wall_ms !== null
        ? s.deadline_at - cur.limits.max_wall_ms
        : ctx.now);
    const due =
      next.limits.max_wall_ms === null
        ? null
        : started + next.limits.max_wall_ms;
    if (due === null || due > ctx.now) {
      for (const tm of Object.values(s.timers)) {
        if (tm.kind === 'deadline' && tm.status !== 'cancelled')
          ctx.emit('TimerCancelled', { timer_id: tm.id });
      }
      if (due !== null)
        ctx.emit('TimerArmed', {
          timer_id: ctx.nextId(),
          kind: 'deadline',
          due_at: due,
          payload: {},
        });
    }
  }
  const w = ctx.state.wait;
  const reopened =
    w?.detail.code === 'loop_exhausted' &&
    w.resume_when.some((r) => r.startsWith('amend('));
  if (ctx.state.status !== 'WAITING' || (w?.reason !== 'policy' && !reopened))
    return;
  const prior = w.detail['prior_wait'] as typeof w | undefined;
  if (!ctx.state.deadline_passed && prior !== undefined) {
    ctx.emit('TaskWaiting', { wait: prior });
    return;
  }
  ctx.emit('TaskResumed', { reason: 'amend' });
  proceed(ctx, w.resume, 'amend');
}
