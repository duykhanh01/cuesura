import { canonicalJson } from '../shared/canonical-json.ts';
import { CanonicalTaskSchema, type CanonicalTask } from '../domain/task.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { requestCancel } from './cancel.ts';
import { onSourceDrift, sameContent } from './revision.ts';
import { FREEZE_PENDING_CODES } from './start.ts';
import { checkDependencies, checkRetryOf, pendingWait, retriage } from './triage.ts';
import { mkWait } from './waits.ts';

function needsConfirmation(task: CanonicalTask): boolean {
  return task.requested_by.kind !== 'human';
}

type CreateTrigger = Extract<Trigger, { kind: 'create_task' }>;

export function onCreateTask(ctx: Ctx, t: CreateTrigger): void {
  if (ctx.hasState) reject('task_exists', { task_id: ctx.state.id });
  const task = CanonicalTaskSchema.parse(t.task);
  if (task.id !== ctx.env.task_id) reject('invalid_trigger', { reason: 'task_id_mismatch' });
  const existing = ctx.related.source_task;
  if (existing !== undefined && existing.task_id !== task.id) {
    reject('task_exists', {
      task_id: existing.task_id,
      same_content: existing.same_content,
    });
  }
  checkDependencies(task, ctx.related);
  checkRetryOf(task, ctx.related);
  const needs = needsConfirmation(task);
  const auto = needs && t.intake_auto_confirm === true;
  ctx.emit('TaskCreated', {
    task: { ...task, revision: 1 },
    needs_confirmation: needs && !auto,
    ...(auto ? { intake_auto_confirmed: true as const } : {}),
  });
  retriage(ctx, ctx.related.deps);
}

export function onConfirmTask(ctx: Ctx): void {
  const s = ctx.state;
  if (!s.needs_confirmation || s.confirmed) {
    ctx.emit('SignalIgnored', {
      reason: 'no_confirmation_needed',
      trigger_kind: 'confirm_task',
    });
    return;
  }
  ctx.emit('TaskConfirmed', { by: ctx.actor });
  retriage(ctx, ctx.related.deps);
}

type SourceUpdated = Extract<Trigger, { kind: 'source_updated' }>;

/** Before execution, revise directly; after execution starts, record source drift. */
export function onSourceUpdated(ctx: Ctx, t: SourceUpdated): void {
  const s = ctx.state;
  const task = CanonicalTaskSchema.parse(t.task);
  if (task.id !== s.id || task.project !== s.project || task.source_key !== s.source_key) {
    reject('invalid_trigger', { reason: 'task_identity_mismatch' });
  }
  if (s.policy_ref !== null) {
    onSourceDrift(ctx, task);
    return;
  }
  if (sameContent(task, s.task)) {
    ctx.emit('SignalIgnored', {
      reason: 'same_content',
      trigger_kind: 'source_updated',
    });
    return;
  }
  checkDependencies(task, ctx.related);
  ctx.emit('TaskRevised', { task: { ...task, revision: s.revision + 1 } });
  retriage(ctx, ctx.related.deps);
}

type DependencyStatus = Extract<Trigger, { kind: 'dependency_status' }>;

export function onDependencyStatus(ctx: Ctx, t: DependencyStatus): void {
  const s = ctx.state;
  if (
    !s.task.depends_on.includes(t.depends_on) ||
    (s.status !== 'PENDING' && s.status !== 'READY')
  ) {
    ctx.emit('SignalIgnored', {
      reason: 'dependency_not_relevant',
      trigger_kind: t.kind,
    });
    return;
  }
  if (t.status === 'FAILED' || t.status === 'CANCELLED') {
    requestCancel(ctx, cascadeReason(t.depends_on, t.status, t.provenance?.terminal_reason));
    return;
  }
  retriage(ctx, { ...ctx.related.deps, [t.depends_on]: t.status });
}

const CASCADE = /^dependency_failed:root=([0-9a-f-]{36})\b/;

/**
 * `dependency_failed:root=<task> via=<prerequisite> (<status>)`: a prerequisite cancelled by this same
 * cascade passes its root on, so every task down the chain names the task that actually ended.
 */
export function cascadeReason(dep: string, status: string, depReason: string | undefined): string {
  const root = (depReason === undefined ? undefined : CASCADE.exec(depReason)?.[1]) ?? dep;
  return `dependency_failed:root=${root} via=${dep} (${status})`;
}

type ConfigChecked = Extract<Trigger, { kind: 'config_checked' }>;

/** PENDING because the config or a capability failed (not because of triage). */
function configPending(ctx: Ctx): boolean {
  const w = ctx.state.wait;
  return (
    ctx.state.status === 'PENDING' &&
    w?.reason === 'needs_info' &&
    FREEZE_PENDING_CODES.includes(w.detail.code)
  );
}

/**
 * Preflight candidate of a task that has not started (FR-002.02/03). Triage blockers come first; the
 * candidate only moves the task between READY and PENDING/needs_info and never freezes a snapshot: the
 * single snapshot is frozen at start under the slot. A task holding the slot is left to its start.
 */
export function onConfigChecked(ctx: Ctx, t: ConfigChecked): void {
  const s = ctx.state;
  if (
    s.policy_ref !== null ||
    (s.status !== 'PENDING' && s.status !== 'READY') ||
    s.execution.holding !== null
  ) {
    ctx.emit('SignalIgnored', {
      reason: 'config_check_stale',
      trigger_kind: t.kind,
      detail: { status: s.status },
    });
    return;
  }
  if (pendingWait(ctx, ctx.related.deps) !== null) {
    retriage(ctx, ctx.related.deps);
    return;
  }
  if (t.outcome.ok) {
    if (configPending(ctx)) ctx.emit('TaskReady', {});
    else
      ctx.emit('SignalIgnored', {
        reason: 'config_unchanged',
        trigger_kind: t.kind,
      });
    return;
  }
  const e = t.outcome.error;
  const wait = mkWait('needs_info', e.code, {
    resume: { kind: 'triage' },
    resume_when: ['task_confirm', 'task_recheck'],
    detail: { error: e },
  });
  if (configPending(ctx) && canonicalJson(s.wait) === canonicalJson(wait)) {
    ctx.emit('SignalIgnored', {
      reason: 'config_unchanged',
      trigger_kind: t.kind,
    });
    return;
  }
  if (s.execution.request !== null) {
    ctx.emit('ExecutionWithdrawn', {
      request_id: s.execution.request.request_id,
      reason: 'config_invalid',
      at: ctx.now,
    });
  }
  ctx.emit('TaskPending', { wait });
}
