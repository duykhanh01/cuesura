import { CanonicalTaskSchema, type CanonicalTask } from '../domain/task.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';
import { onSourceDrift, sameContent } from './revision.ts';
import { checkDependencies, checkRetryOf, retriage } from './triage.ts';

/** Task cần người xác nhận khi không do chính người dùng tạo (SPEC.md §5.2). */
function needsConfirmation(task: CanonicalTask): boolean {
  return task.requested_by.kind !== 'human';
}

type CreateTrigger = Extract<Trigger, { kind: 'create_task' }>;

/** `create_task`: dedup theo `(project, source_key)` (FR-007), kiểm dependency và retry rồi triage. */
export function onCreateTask(ctx: Ctx, t: CreateTrigger): void {
  if (ctx.hasState) reject('task_exists', { task_id: ctx.state.id });
  const task = CanonicalTaskSchema.parse(t.task);
  if (task.id !== ctx.env.task_id) reject('invalid_trigger', { reason: 'task_id_mismatch' });
  const existing = ctx.related.source_task;
  if (existing !== undefined && existing.task_id !== task.id) {
    reject('task_exists', { task_id: existing.task_id, same_content: existing.same_content });
  }
  checkDependencies(task, ctx.related);
  checkRetryOf(task, ctx.related);
  ctx.emit('TaskCreated', { task: { ...task, revision: 1 }, needs_confirmation: needsConfirmation(task) });
  retriage(ctx, ctx.related.deps);
}

export function onConfirmTask(ctx: Ctx): void {
  const s = ctx.state;
  if (!s.needs_confirmation || s.confirmed) {
    ctx.emit('SignalIgnored', { reason: 'no_confirmation_needed', trigger_kind: 'confirm_task' });
    return;
  }
  ctx.emit('TaskConfirmed', { by: ctx.actor });
  retriage(ctx, ctx.related.deps);
}

type SourceUpdated = Extract<Trigger, { kind: 'source_updated' }>;

/** Trước khi chạy: revision mới (`TaskRevised`). Sau khi chạy: source drift (FR-011). */
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
    ctx.emit('SignalIgnored', { reason: 'same_content', trigger_kind: 'source_updated' });
    return;
  }
  checkDependencies(task, ctx.related);
  ctx.emit('TaskRevised', { task: { ...task, revision: s.revision + 1 } });
  retriage(ctx, ctx.related.deps);
}

type DependencyStatus = Extract<Trigger, { kind: 'dependency_status' }>;

export function onDependencyStatus(ctx: Ctx, t: DependencyStatus): void {
  const s = ctx.state;
  if (!s.task.depends_on.includes(t.depends_on) || (s.status !== 'PENDING' && s.status !== 'READY')) {
    ctx.emit('SignalIgnored', { reason: 'dependency_not_relevant', trigger_kind: t.kind });
    return;
  }
  retriage(ctx, { ...ctx.related.deps, [t.depends_on]: t.status });
}
