import type { DomainEventDraft } from '../domain/event.ts';
import { cursorAfter, RESOLVED_OPERATION_STATUSES, verifyRuntimeHash, type FrozenRuntimeContext, type OperationKind } from '../domain/runtime.ts';
import { isTerminal, type OperationMirror, type ResumeAction, type TaskState } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { reject, type Ctx } from './context.ts';

// Pure runtime handlers of feature 002: execution queue/slot, operation receipts and output ingest.
// Facts (slot holder, queue head, receipts, cursors) come from the application layer; nothing here does I/O.

type TriggerOf<K extends Trigger['kind']> = Extract<Trigger, { kind: K }>;

export function isUnresolved(o: OperationMirror): boolean {
  return !RESOLVED_OPERATION_STATUSES.includes(o.status);
}

/** Operations whose claim must keep the execution slot (FR-044.06): unresolved and marked slot-bound. */
export function slotBoundOperations(s: TaskState): OperationMirror[] {
  return Object.values(s.operations).filter((o) => o.holds_slot && isUnresolved(o));
}

/** Validates the 002 runtime snapshot carried by `start` against the frozen policy being accepted. */
export function acceptRuntime(ctx: Ctx, rt: FrozenRuntimeContext, policy: { revision: number; base_sha: string }): void {
  const s = ctx.state;
  if (rt.task_id !== s.id) reject('invalid_trigger', { reason: 'runtime_task_mismatch' });
  if (rt.revision !== policy.revision || rt.base_sha !== policy.base_sha) reject('invalid_trigger', { reason: 'runtime_freeze_mismatch' });
  if (!verifyRuntimeHash(rt)) reject('invalid_trigger', { reason: 'runtime_hash_mismatch' });
  if (rt.target.base_ref !== s.task.base_branch) reject('invalid_trigger', { reason: 'runtime_base_ref_mismatch' });
}

/**
 * Ask for the slot. A task that never started queues as `fresh` and stays READY; a started task queues
 * as `resumed` and carries the action to resume once granted. One open request per task (FR-044.01).
 */
export function onRequestExecution(ctx: Ctx): void {
  const s = ctx.state;
  if (s.cancellation !== null || s.completion !== null) reject('invalid_trigger', { reason: 'not_executable' });
  if (s.execution.holding !== null) {
    ctx.emit('SignalIgnored', { reason: 'already_holding', trigger_kind: 'request_execution' });
    return;
  }
  const fresh = s.policy_ref === null;
  if (fresh ? s.status !== 'READY' : s.status !== 'WAITING' && s.status !== 'RUNNING') {
    reject('invalid_trigger', { reason: 'not_queueable', status: s.status });
  }
  const resume: ResumeAction | null = !fresh && s.status === 'WAITING' ? (s.wait?.resume ?? null) : null;
  const priority = s.task.priority;
  const open = s.execution.request;
  if (open !== null) {
    if (open.priority === priority && canonicalJson(open.resume_action) === canonicalJson(resume)) {
      ctx.emit('SignalIgnored', { reason: 'already_queued', trigger_kind: 'request_execution', detail: { request_id: open.request_id } });
      return;
    }
    ctx.emit('ExecutionIntentUpdated', { request_id: open.request_id, priority, resume_action: resume });
    return;
  }
  ctx.emit('ExecutionQueued', {
    request_id: ctx.nextId(),
    group: fresh ? 'fresh' : 'resumed',
    priority,
    resume_action: resume,
    requested_at: ctx.now,
  });
}

/**
 * Grant the slot to this task's open request. The store reads the slot holder and queue head inside the
 * same BEGIN IMMEDIATE transaction; a stale view is rejected rather than granting twice.
 */
export function onGrantExecution(ctx: Ctx, t: TriggerOf<'grant_execution'>): void {
  const s = ctx.state;
  const r = s.execution.request;
  if (r === null || r.request_id !== t.request_id) {
    ctx.emit('SignalIgnored', { reason: 'stale_request', trigger_kind: t.kind, detail: { request_id: t.request_id } });
    return;
  }
  if (s.cancellation !== null || s.completion !== null) {
    ctx.emit('ExecutionWithdrawn', { request_id: r.request_id, reason: s.cancellation !== null ? 'cancelling' : 'completion', at: ctx.now });
    return;
  }
  const facts = ctx.related.execution;
  if (facts === undefined) reject('invalid_trigger', { reason: 'missing_execution_facts' });
  if (facts.slot !== null) reject('invalid_trigger', { reason: 'slot_held', holder_task_id: facts.slot.holder_task_id });
  if (facts.queue_head !== r.request_id) reject('invalid_trigger', { reason: 'not_queue_head', queue_head: facts.queue_head });
  ctx.emit('ExecutionGranted', {
    request_id: r.request_id,
    at: ctx.now,
    waited_ms: s.execution.accumulated_wait_ms + Math.max(0, ctx.now - r.requested_at),
  });
}

/** Release only after every slot-bound operation is resolved; an unresolved claim keeps the slot. */
export function onReleaseExecution(ctx: Ctx, t: TriggerOf<'release_execution'>): void {
  const h = ctx.state.execution.holding;
  if (h === null || h.request_id !== t.request_id) {
    ctx.emit('SignalIgnored', { reason: 'not_holding', trigger_kind: t.kind, detail: { request_id: t.request_id } });
    return;
  }
  const pending = slotBoundOperations(ctx.state);
  if (pending.length > 0) reject('invalid_trigger', { reason: 'unresolved_operations', operation_ids: pending.map((o) => o.id) });
  ctx.emit('ExecutionReleased', { request_id: h.request_id, reason: t.reason, at: ctx.now });
}

/** Called before a terminal event: withdraw an open request and release a slot nothing still needs. */
export function settleExecutionOnClose(ctx: Ctx): void {
  const s = ctx.state;
  if (s.execution.request !== null) {
    ctx.emit('ExecutionWithdrawn', { request_id: s.execution.request.request_id, reason: 'task_ended', at: ctx.now });
  }
  const h = ctx.state.execution.holding;
  if (h !== null && slotBoundOperations(ctx.state).length === 0) {
    ctx.emit('ExecutionReleased', { request_id: h.request_id, reason: 'task_ended', at: ctx.now });
  }
}

const NEXT_STATUS: Record<OperationMirror['status'], readonly OperationMirror['status'][]> = {
  registered: ['running', 'finished', 'not_launched', 'unknown', 'lost'],
  running: ['running', 'finished', 'unknown', 'lost'],
  unknown: ['running', 'finished', 'not_launched', 'unknown', 'lost'],
  lost: ['finished', 'not_launched', 'lost'],
  finished: [],
  not_launched: [],
};

/** Normalized receipt from the runner files. A late receipt for a resolved operation only gets logged. */
export function onOperationResult(ctx: Ctx, t: TriggerOf<'operation_result'>): void {
  const o = ctx.state.operations[t.operation_id];
  if (o === undefined) reject('invalid_trigger', { reason: 'unknown_operation', operation_id: t.operation_id });
  if (!isUnresolved(o)) {
    ctx.emit('SignalIgnored', { reason: 'operation_resolved', trigger_kind: t.kind, detail: { operation_id: o.id } });
    return;
  }
  if (!NEXT_STATUS[o.status].includes(t.status)) reject('invalid_trigger', { reason: 'operation_transition', from: o.status, to: t.status });
  if (t.status === 'finished' && (t.outcome === null || t.finished_at === null)) reject('invalid_trigger', { reason: 'finished_without_outcome' });
  if (t.status !== 'finished' && t.outcome !== null) reject('invalid_trigger', { reason: 'outcome_before_finish' });
  // "Not launched" is a claim that nothing ran: it must not carry any process identity.
  if (t.status === 'not_launched' && (t.processes.length > 0 || t.started_at !== null)) reject('invalid_trigger', { reason: 'not_launched_with_process' });
  ctx.emit('OperationObserved', {
    operation_id: o.id,
    status: t.status,
    outcome: t.outcome,
    invocation_id: t.invocation_id,
    processes: t.processes,
    started_at: t.started_at,
    finished_at: t.finished_at,
    receipt_digest: t.receipt_digest,
  });
}

/**
 * Complete records read past the stored cursor. The cursor only moves forward; a repeat of an ingested
 * range is ignored, so re-reading a segment after a crash never duplicates events (FR-036).
 */
export function onIngestRecord(ctx: Ctx, t: TriggerOf<'ingest_record'>): void {
  const o = ctx.state.operations[t.operation_id];
  if (o === undefined) reject('invalid_trigger', { reason: 'unknown_operation', operation_id: t.operation_id });
  const next = { operation_id: o.id, ...t.cursor };
  const prev = o.cursor === null ? null : { operation_id: o.id, ...o.cursor };
  if (!cursorAfter(next, prev)) {
    ctx.emit('SignalIgnored', { reason: 'stale_cursor', trigger_kind: t.kind, detail: { operation_id: o.id, cursor: t.cursor } });
    return;
  }
  for (const a of t.artifacts) {
    if (a.operation_id !== o.id) reject('invalid_trigger', { reason: 'artifact_operation_mismatch', artifact_id: a.artifact_id });
    const known = ctx.state.artifacts[a.artifact_id];
    if (known !== undefined && canonicalJson(known) !== canonicalJson(a)) reject('invalid_trigger', { reason: 'artifact_conflict', artifact_id: a.artifact_id });
  }
  ctx.emit('OutputIngested', { operation_id: o.id, cursor: t.cursor, records: t.records, digest: t.digest });
  for (const a of t.artifacts) if (ctx.state.artifacts[a.artifact_id] === undefined) ctx.emit('ArtifactIngested', { artifact: a });
}

export type OperationClaim = {
  operation_id: string;
  kind: OperationKind;
  launch_nonce: string;
  unit: string;
  holds_slot: boolean;
};

export type OperationClaimError = 'slot_not_held' | 'operation_exists' | 'effect_has_open_operation';

/**
 * Drafts registering an operation in the same transaction as `EffectStarted`, so its identity is
 * committed before anything is spawned (T025).
 */
export function registerOperation(
  s: TaskState,
  effect: { id: string; attempt_id: string | null },
  op: OperationClaim,
  now: number,
): { ok: true; events: DomainEventDraft[] } | { ok: false; reason: OperationClaimError } {
  if (s.operations[op.operation_id] !== undefined) return { ok: false, reason: 'operation_exists' };
  if (Object.values(s.operations).some((o) => o.effect_id === effect.id && isUnresolved(o))) {
    return { ok: false, reason: 'effect_has_open_operation' };
  }
  if (op.holds_slot && s.execution.holding === null) return { ok: false, reason: 'slot_not_held' };
  return {
    ok: true,
    events: [
      {
        type: 'OperationRegistered',
        revision: s.revision,
        actor: 'store',
        payload: {
          operation_id: op.operation_id,
          effect_id: effect.id,
          attempt_id: effect.attempt_id,
          kind: op.kind,
          launch_nonce: op.launch_nonce,
          unit: op.unit,
          holds_slot: op.holds_slot,
          at: now,
        },
      },
    ],
  };
}

/** Whether `s` can still be granted work by the 002 daemon at all (used by queue selection and health). */
export function executable(s: TaskState): boolean {
  return !isTerminal(s.status) && s.cancellation === null && s.completion === null;
}
