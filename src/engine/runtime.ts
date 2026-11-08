import { holdsSlot } from '../domain/effect.ts';
import type { DomainEventDraft } from '../domain/event.ts';
import {
  cursorAfter,
  RESOLVED_OPERATION_STATUSES,
  verifyRuntimeHash,
  type FrozenRuntimeContext,
  type OperationKind,
} from '../domain/runtime.ts';
import {
  isTerminal,
  type EffectMirror,
  type OperationMirror,
  type ResumeAction,
  type TaskState,
} from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { reject, type Ctx } from './context.ts';
import { inFlight, requestReconcile } from './effects.ts';
import { proceed } from './interpreter.ts';
import { isPaused, waitPaused } from './pause.ts';
import { mkWait, waitTask } from './waits.ts';

// Pure runtime handlers of feature 002: execution queue/slot, operation receipts and output ingest.
// Facts (slot holder, queue head, receipts, cursors) come from the application layer; nothing here does I/O.

type TriggerOf<K extends Trigger['kind']> = Extract<Trigger, { kind: K }>;

export function isUnresolved(o: OperationMirror): boolean {
  return !RESOLVED_OPERATION_STATUSES.includes(o.status);
}

/**
 * A probe of slot-bound work (a reconcile of setup, an agent, gates or a publish, or a reconcile of such a
 * probe) may run that work again or still have its processes: it binds the slot as the work does.
 */
export function slotProbe(s: TaskState, effectId: string): boolean {
  let e = s.effects[effectId];
  for (let hops = 0; e?.kind === 'reconcile' && hops < 64; hops++) {
    const target: EffectMirror | undefined =
      e.target_effect_id === null ? undefined : s.effects[e.target_effect_id];
    if (target === undefined) return false;
    if (holdsSlot(target.kind)) return true;
    e = target;
  }
  return false;
}

/**
 * Operations whose claim must keep the execution slot (FR-044.01/06): unresolved and slot-bound, the
 * operations of a probe of slot-bound work included.
 */
export function slotBoundOperations(s: TaskState): OperationMirror[] {
  return Object.values(s.operations).filter(
    (o) => isUnresolved(o) && (o.holds_slot || slotProbe(s, o.effect_id)),
  );
}

/** Validates the 002 runtime snapshot carried by `start` against the frozen policy being accepted. */
export function acceptRuntime(
  ctx: Ctx,
  rt: FrozenRuntimeContext,
  policy: { revision: number; base_sha: string },
): void {
  const s = ctx.state;
  if (rt.task_id !== s.id) reject('invalid_trigger', { reason: 'runtime_task_mismatch' });
  if (rt.revision !== policy.revision || rt.base_sha !== policy.base_sha)
    reject('invalid_trigger', { reason: 'runtime_freeze_mismatch' });
  if (!verifyRuntimeHash(rt)) reject('invalid_trigger', { reason: 'runtime_hash_mismatch' });
  if (rt.target.base_ref !== s.task.base_branch)
    reject('invalid_trigger', { reason: 'runtime_base_ref_mismatch' });
}

/**
 * Ask for the slot. A task that never started queues as `fresh` and stays READY; a started task queues
 * as `resumed` and carries the action to resume once granted. One open request per task (FR-044.01).
 */
export function onRequestExecution(ctx: Ctx): void {
  const s = ctx.state;
  if (s.cancellation !== null || s.completion !== null)
    reject('invalid_trigger', { reason: 'not_executable' });
  if (s.execution.holding !== null) {
    ctx.emit('SignalIgnored', {
      reason: 'already_holding',
      trigger_kind: 'request_execution',
    });
    return;
  }
  if (isPaused(ctx)) {
    ctx.emit('SignalIgnored', { reason: 'paused', trigger_kind: 'request_execution' });
    return;
  }
  const fresh = s.policy_ref === null;
  if (fresh ? s.status !== 'READY' : s.status !== 'WAITING' && s.status !== 'RUNNING') {
    reject('invalid_trigger', { reason: 'not_queueable', status: s.status });
  }
  const resume: ResumeAction | null =
    !fresh && s.status === 'WAITING' ? (s.wait?.resume ?? null) : null;
  const priority = s.task.priority;
  const open = s.execution.request;
  if (open !== null) {
    if (open.priority === priority && canonicalJson(open.resume_action) === canonicalJson(resume)) {
      ctx.emit('SignalIgnored', {
        reason: 'already_queued',
        trigger_kind: 'request_execution',
        detail: { request_id: open.request_id },
      });
      return;
    }
    ctx.emit('ExecutionIntentUpdated', {
      request_id: open.request_id,
      priority,
      resume_action: resume,
    });
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
 * Grant the slot to this task's open request. The store reads the slot holders and queue head inside the
 * same BEGIN IMMEDIATE transaction; a stale view is rejected rather than granting twice.
 */
export function onGrantExecution(ctx: Ctx, t: TriggerOf<'grant_execution'>): void {
  const s = ctx.state;
  const r = s.execution.request;
  if (r === null || r.request_id !== t.request_id) {
    ctx.emit('SignalIgnored', {
      reason: 'stale_request',
      trigger_kind: t.kind,
      detail: { request_id: t.request_id },
    });
    return;
  }
  if (t.started_only === true && r.group === 'fresh')
    reject('invalid_trigger', { reason: 'queue_paused', request_id: r.request_id });
  if (s.cancellation !== null || s.completion !== null) {
    ctx.emit('ExecutionWithdrawn', {
      request_id: r.request_id,
      reason: s.cancellation !== null ? 'cancelling' : 'completion',
      at: ctx.now,
    });
    return;
  }
  const facts = ctx.related.execution;
  if (facts === undefined) reject('invalid_trigger', { reason: 'missing_execution_facts' });
  if (t.passed_over?.some((id) => id === r.request_id) === true)
    reject('invalid_trigger', { reason: 'passed_over', request_id: r.request_id });
  const capacity = t.capacity ?? 1;
  const waited_ms = s.execution.accumulated_wait_ms + Math.max(0, ctx.now - r.requested_at);
  if (t.lender_task_id !== undefined) {
    grantLoan(ctx, t.lender_task_id, r, facts, capacity, waited_ms);
    return;
  }
  if (facts.holders.length >= capacity)
    reject('invalid_trigger', {
      reason: 'slot_held',
      holder_task_ids: facts.holders,
      capacity,
    });
  if (facts.queue_head !== r.request_id)
    reject('invalid_trigger', {
      reason: 'not_queue_head',
      queue_head: facts.queue_head,
    });
  ctx.emit('ExecutionGranted', { request_id: r.request_id, at: ctx.now, waited_ms });
  // A started task waiting for the slot resumes the step it stopped at; a fresh one waits for its start.
  const w = ctx.state.wait;
  if (ctx.state.status === 'WAITING' && w?.detail.code === 'execution_slot')
    proceed(ctx, w.resume, 'execution_granted');
}

/**
 * A loan of a reservation (FR-044.02): only a task that never started borrows, each reservation lends
 * to one task at a time, and at most `capacity` loans run, so no more than 2N tasks run at once.
 */
function grantLoan(
  ctx: Ctx,
  lender: string,
  r: NonNullable<TaskState['execution']['request']>,
  facts: NonNullable<Ctx['related']['execution']>,
  capacity: number,
  waited_ms: number,
): void {
  if (r.group !== 'fresh') reject('invalid_trigger', { reason: 'loan_started_task' });
  if (lender === ctx.state.id) reject('invalid_trigger', { reason: 'loan_to_self' });
  if (facts.lender?.lendable !== true)
    reject('invalid_trigger', { reason: 'not_lendable', lender_task_id: lender });
  if ((facts.loans ?? 0) >= capacity)
    reject('invalid_trigger', { reason: 'loans_full', loans: facts.loans, capacity });
  if (facts.lender.loan_head !== r.request_id)
    reject('invalid_trigger', { reason: 'not_loan_head', loan_head: facts.lender.loan_head });
  ctx.emit('ExecutionGranted', {
    request_id: r.request_id,
    at: ctx.now,
    waited_ms,
    lender_task_id: lender,
    ...(facts.lender.reserved_at === null ? {} : { lender_reserved_at: facts.lender.reserved_at }),
  });
}

/** A loan whose lender reclaimed or lost the reservation it lent; unknown counts as still active. */
export function loanEnded(ctx: Ctx): boolean {
  const h = ctx.state.execution.holding;
  return h?.lender_task_id !== undefined && ctx.related.loan?.active === false;
}

/** Runtime (002) tasks share one slot; legacy tasks without a runtime snapshot never queue for it. */
function usesSlot(s: TaskState): boolean {
  return s.runtime_ref !== null;
}

/**
 * Called before a started task runs slot-bound work (FR-044.05). Without the slot the task waits as
 * WAITING/policy execution_slot and queues as `resumed` with `resume`; the deadline keeps running.
 * Returns true when the caller must stop here.
 */
export function waitForSlot(ctx: Ctx, resume: ResumeAction): boolean {
  const s = ctx.state;
  // Retries reach slot-bound work without a new step; a paused task holds them here too (issue #142).
  if (isPaused(ctx)) {
    waitPaused(ctx, resume);
    return true;
  }
  if (!usesSlot(s)) return false;
  const h = s.execution.holding;
  if (h !== null && !loanEnded(ctx)) return false;
  // A loan whose lender came back ends here, before the next slot-bound work (FR-044.04). With a claim
  // still unresolved it is kept until settleSlot can give it back.
  if (h !== null && slotBoundOperations(s).length === 0)
    ctx.emit('ExecutionReleased', { request_id: h.request_id, reason: 'loan_ended', at: ctx.now });
  waitTask(
    ctx,
    mkWait('policy', 'execution_slot', {
      resume,
      resume_when: ['grant_execution'],
    }),
  );
  // Source drift may have taken the wait over at a safe boundary; then the task is not queued.
  if (ctx.state.wait?.detail.code === 'execution_slot') onRequestExecution(ctx);
  return true;
}

/** Slot-bound work this task still has: pending or in-flight slot effects, or unresolved slot operations. */
export function hasSlotWork(s: TaskState): boolean {
  if (slotBoundOperations(s).length > 0) return true;
  return Object.values(s.effects).some(
    (e) => (holdsSlot(e.kind) || slotProbe(s, e.id)) && (e.status === 'pending' || inFlight(e)),
  );
}

/**
 * A started task waiting outside (CI, merge, a person, cooldown) keeps its own slot as a reservation
 * (FR-044.02). A pause, a deadline, a cancel or a merge being drained gives it back instead.
 */
function reservable(s: TaskState): boolean {
  const code = s.wait?.detail.code;
  return (
    s.status === 'WAITING' &&
    (s.pause ?? null) === null &&
    s.cancellation === null &&
    s.completion === null &&
    !s.deadline_passed &&
    code !== 'deadline' &&
    code !== 'execution_slot'
  );
}

/**
 * Run after every decision on a runtime task (FR-044.01/02/05). Withdraws a request the task no longer
 * qualifies for. The slot belongs to the task, not to a step: a RUNNING task keeps it across every step
 * and effect, slot-bound or not (issue #203). Once the task stops running to wait outside it keeps the
 * slot as a reservation another task may borrow, and runs on it again as soon as it comes back. A loan,
 * or a slot whose task waits for anything else, goes back instead; an unresolved claim keeps it.
 */
export function settleSlot(ctx: Ctx): void {
  const s = ctx.state;
  if (!usesSlot(s) || isTerminal(s.status)) return;
  const r = s.execution.request;
  if (r !== null) {
    const fresh = r.group === 'fresh';
    const stillQueued = fresh
      ? s.status === 'READY' && s.policy_ref === null
      : s.status === 'WAITING' && s.wait?.detail.code === 'execution_slot';
    if (!stillQueued)
      ctx.emit('ExecutionWithdrawn', {
        request_id: r.request_id,
        reason: fresh ? 'not_ready' : 'not_waiting_for_slot',
        at: ctx.now,
      });
  }
  const h = ctx.state.execution.holding;
  if (h === null || ctx.state.policy_ref === null) return;
  if (ctx.state.status === 'RUNNING') {
    // Only slot-bound work takes the reservation back: a CI poll or a GitHub write leaves it, and its
    // time and any loan of it, as they are.
    if (h.reserved_at !== undefined && hasSlotWork(ctx.state))
      ctx.emit('ExecutionReclaimed', { request_id: h.request_id, at: ctx.now });
    return;
  }
  if (hasSlotWork(ctx.state)) return;
  if (h.lender_task_id === undefined && reservable(ctx.state)) {
    if (h.reserved_at === undefined)
      ctx.emit('ExecutionReserved', { request_id: h.request_id, at: ctx.now });
    return;
  }
  ctx.emit('ExecutionReleased', {
    request_id: h.request_id,
    reason: h.lender_task_id === undefined ? 'waiting' : 'loan_ended',
    at: ctx.now,
  });
  // A loan kept for a claim at the boundary goes back now; the task queues for a slot of its own.
  const w = ctx.state.wait;
  if (
    ctx.state.status === 'WAITING' &&
    w?.detail.code === 'execution_slot' &&
    ctx.state.execution.request === null
  )
    onRequestExecution(ctx);
}

/** Release only after every slot-bound operation is resolved; an unresolved claim keeps the slot. */
export function onReleaseExecution(ctx: Ctx, t: TriggerOf<'release_execution'>): void {
  const h = ctx.state.execution.holding;
  // The task may have come back between the read of the reservation and this release, or be running
  // work that needs no slot; it then keeps the reservation until it waits again.
  if (
    t.reason === 'reservation_expired' &&
    h !== null &&
    (h.reserved_at === undefined || ctx.state.status === 'RUNNING')
  ) {
    ctx.emit('SignalIgnored', {
      reason: 'not_reserved',
      trigger_kind: t.kind,
      detail: { request_id: t.request_id },
    });
    return;
  }
  if (h === null || h.request_id !== t.request_id) {
    ctx.emit('SignalIgnored', {
      reason: 'not_holding',
      trigger_kind: t.kind,
      detail: { request_id: t.request_id },
    });
    return;
  }
  const pending = slotBoundOperations(ctx.state);
  if (pending.length > 0)
    reject('invalid_trigger', {
      reason: 'unresolved_operations',
      operation_ids: pending.map((o) => o.id),
    });
  ctx.emit('ExecutionReleased', {
    request_id: h.request_id,
    reason: t.reason,
    at: ctx.now,
  });
}

/** Called before a terminal event: withdraw an open request and release a slot nothing still needs. */
export function settleExecutionOnClose(ctx: Ctx): void {
  const s = ctx.state;
  if (s.execution.request !== null) {
    ctx.emit('ExecutionWithdrawn', {
      request_id: s.execution.request.request_id,
      reason: 'task_ended',
      at: ctx.now,
    });
  }
  const h = ctx.state.execution.holding;
  if (h !== null && slotBoundOperations(ctx.state).length === 0) {
    ctx.emit('ExecutionReleased', {
      request_id: h.request_id,
      reason: 'task_ended',
      at: ctx.now,
    });
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
  if (o === undefined)
    reject('invalid_trigger', {
      reason: 'unknown_operation',
      operation_id: t.operation_id,
    });
  if (!isUnresolved(o)) {
    ctx.emit('SignalIgnored', {
      reason: 'operation_resolved',
      trigger_kind: t.kind,
      detail: { operation_id: o.id },
    });
    return;
  }
  if (!NEXT_STATUS[o.status].includes(t.status))
    reject('invalid_trigger', {
      reason: 'operation_transition',
      from: o.status,
      to: t.status,
    });
  if (t.status === 'finished' && (t.outcome === null || t.finished_at === null))
    reject('invalid_trigger', { reason: 'finished_without_outcome' });
  if (t.status !== 'finished' && t.outcome !== null)
    reject('invalid_trigger', { reason: 'outcome_before_finish' });
  // "Not launched" is a claim that nothing ran: it must not carry any process identity.
  if (t.status === 'not_launched' && (t.processes.length > 0 || t.started_at !== null))
    reject('invalid_trigger', { reason: 'not_launched_with_process' });
  const before = o.status;
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
  // New evidence about an operation whose effect waits unknown with no probe left (a probe that could
  // not see its processes gone ended still_unknown): probe again now. Bounded, as it follows only a
  // change of the operation's status, and every probe checks the processes first (Constitution III).
  const e = ctx.state.effects[o.effect_id];
  if (!isTerminal(ctx.state.status) && t.status !== before && e?.status === 'unknown')
    requestReconcile(ctx, e, { afterRunning: true });
  // A task that ended while this operation was unresolved kept the slot for it; free it with the last one.
  const h = ctx.state.execution.holding;
  if (isTerminal(ctx.state.status) && h !== null && slotBoundOperations(ctx.state).length === 0) {
    ctx.emit('ExecutionReleased', {
      request_id: h.request_id,
      reason: 'task_ended',
      at: ctx.now,
    });
  }
}

/**
 * Complete records read past the stored cursor. The cursor only moves forward; a repeat of an ingested
 * range is ignored, so re-reading a segment after a crash never duplicates events (FR-036). Artifacts
 * that become final after the last record (exit.json, the sealed segments) arrive with the stored cursor
 * and no records, or with no cursor when the run never wrote a record: only the artifacts are recorded.
 */
export function onIngestRecord(ctx: Ctx, t: TriggerOf<'ingest_record'>): void {
  const o = ctx.state.operations[t.operation_id];
  if (o === undefined)
    reject('invalid_trigger', {
      reason: 'unknown_operation',
      operation_id: t.operation_id,
    });
  const prev = o.cursor === null ? null : { operation_id: o.id, ...o.cursor };
  const artifactsOnly =
    t.records === 0 &&
    canonicalJson(t.cursor) === canonicalJson(o.cursor) &&
    t.artifacts.some((a) => ctx.state.artifacts[a.artifact_id] === undefined);
  if (
    !artifactsOnly &&
    (t.cursor === null || !cursorAfter({ operation_id: o.id, ...t.cursor }, prev))
  ) {
    ctx.emit('SignalIgnored', {
      reason: 'stale_cursor',
      trigger_kind: t.kind,
      detail: { operation_id: o.id, cursor: t.cursor },
    });
    return;
  }
  for (const a of t.artifacts) {
    if (a.operation_id !== o.id)
      reject('invalid_trigger', {
        reason: 'artifact_operation_mismatch',
        artifact_id: a.artifact_id,
      });
    const known = ctx.state.artifacts[a.artifact_id];
    if (known !== undefined && canonicalJson(known) !== canonicalJson(a))
      reject('invalid_trigger', {
        reason: 'artifact_conflict',
        artifact_id: a.artifact_id,
      });
  }
  if (!artifactsOnly && t.cursor !== null)
    ctx.emit('OutputIngested', {
      operation_id: o.id,
      cursor: t.cursor,
      records: t.records,
      digest: t.digest,
    });
  for (const a of t.artifacts)
    if (ctx.state.artifacts[a.artifact_id] === undefined)
      ctx.emit('ArtifactIngested', { artifact: a });
}

export type OperationClaim = {
  operation_id: string;
  kind: OperationKind;
  launch_nonce: string;
  unit: string;
  holds_slot: boolean;
};

export type OperationClaimError =
  | 'slot_not_held'
  | 'operation_exists'
  | 'effect_has_open_operation';

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
