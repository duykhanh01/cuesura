import { assertNever } from '../shared/assert-never.ts';
import type { DomainEvent, DomainEventDraft } from '../domain/event.ts';
import type { Hash } from '../shared/brand.ts';
import { BaseUpdateSchema, cancelReadRef } from '../domain/runtime.ts';
import {
  isTerminal,
  STATE_SCHEMA_VERSION,
  streakKey,
  type Blocker,
  type PrBodyState,
  type TaskState,
  type TaskStatus,
} from '../domain/state.ts';

export class InvalidTransition extends Error {
  override name = 'InvalidTransition';
}

/** Self-transitions update wait reasons. Terminal states have no outgoing status transitions. */
const EDGES: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['PENDING', 'READY', 'FAILED', 'CANCELLED'],
  READY: ['PENDING', 'RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['WAITING', 'DONE', 'FAILED', 'CANCELLED'],
  WAITING: ['WAITING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
};

export function isAllowedEdge(from: TaskStatus, to: TaskStatus): boolean {
  return EDGES[from].includes(to);
}

function moveTo(s: TaskState, to: TaskStatus, type: string): void {
  if (!isAllowedEdge(s.status, to))
    throw new InvalidTransition(`${type}: invalid transition from ${s.status} to ${to}`);
  s.status = to;
}

type AnyEvent = DomainEvent | DomainEventDraft;

/**
 * Events a terminal task still accepts. Besides `SignalIgnored`, an operation that outlived the task
 * may report its receipt and output, and the slot it kept is released once nothing still needs it;
 * none of them touches the task status.
 */
export const POST_TERMINAL_EVENTS: readonly DomainEvent['type'][] = [
  'SignalIgnored',
  'OperationObserved',
  'OutputIngested',
  'ArtifactIngested',
  'ExecutionReleased',
];

export function evolve(state: TaskState | null, event: AnyEvent): TaskState {
  return applyInPlace(state === null ? null : structuredClone(state), structuredClone(event));
}

/**
 * decide already cloned the state. This mutating variant retains payload references; callers must
 * clone events.
 */
export function applyInPlace(state: TaskState | null, event: AnyEvent): TaskState {
  if (state === null) {
    if (event.type !== 'TaskCreated')
      throw new InvalidTransition(`${event.type} occurred before TaskCreated`);
    const { task, needs_confirmation } = event.payload;
    return {
      schema_version: STATE_SCHEMA_VERSION,
      id: task.id,
      project: task.project,
      source_key: task.source_key,
      revision: task.revision,
      version: 1,
      status: 'PENDING',
      wait: null,
      task,
      needs_confirmation,
      confirmed: false,
      policy_ref: null,
      context_ref: null,
      current_step: null,
      step_visits: {},
      attempts: {},
      current_attempt: {},
      rungs: { by_step: {}, floor_level: null },
      failure_streaks: {},
      class_counters: {},
      escalated_steps: [],
      last_fix_step: null,
      budget: {
        agent_runs: { limit: 0, used: 0, reserved: 0 },
        escalations: { limit: 0, used: 0 },
        reservations: {},
      },
      effects: {},
      timers: {},
      questions: {},
      approvals: {},
      evidence: {
        gates: [],
        reviews: [],
        review_skipped: [],
        ci: [],
        base_relations: [],
        publishes: [],
      },
      head_sha: null,
      pr_ref: null,
      base_sha: null,
      ci_polls: 0,
      merged: false,
      source_drift: null,
      cancellation: null,
      started_at: null,
      deadline_at: null,
      deadline_passed: false,
      terminal: null,
      ...emptyRuntime(),
    };
  }

  const s = state;
  if (isTerminal(s.status) && !POST_TERMINAL_EVENTS.includes(event.type)) {
    throw new InvalidTransition(
      `${event.type} occurred after the task reached a terminal state (${s.status})`,
    );
  }
  s.version += 1;

  switch (event.type) {
    case 'TaskCreated':
      throw new InvalidTransition('TaskCreated received for an existing task');
    case 'TaskRevised':
      s.task = event.payload.task;
      s.revision = event.payload.task.revision;
      break;
    case 'TaskConfirmed':
      s.confirmed = true;
      break;
    case 'TaskReady':
      moveTo(s, 'READY', event.type);
      s.wait = null;
      break;
    case 'TaskPending':
      moveTo(s, 'PENDING', event.type);
      s.wait = event.payload.wait;
      break;
    case 'TaskWaiting':
      moveTo(s, 'WAITING', event.type);
      s.wait = event.payload.wait;
      break;
    case 'TaskResumed':
      moveTo(s, 'RUNNING', event.type);
      s.wait = null;

      if (event.payload.reason.startsWith('drift:')) s.source_drift = null;
      break;

    case 'PolicyFrozen': {
      const { policy, context } = event.payload;
      const first = s.policy_ref === null;
      s.policy_ref = {
        revision: policy.revision,
        hash: policy.policy_hash,
        version: policy.policy_version,
      };
      s.context_ref = {
        revision: context.revision,
        hash: context.context_hash,
      };
      if (first) {
        s.started_at = event.payload.started_at ?? null;
        // Budgets belong to the task and never reset on a revision change.
        s.budget.agent_runs.limit = policy.limits.max_agent_runs;
        s.budget.escalations.limit = policy.limits.max_escalations;
      }
      if (s.status === 'READY') moveTo(s, 'RUNNING', event.type);
      break;
    }
    case 'PolicyAmended': {
      const p = event.payload.policy;
      s.policy_ref = {
        revision: p.revision,
        hash: p.policy_hash,
        version: p.policy_version,
      };
      s.budget.agent_runs.limit = p.limits.max_agent_runs;
      s.budget.escalations.limit = p.limits.max_escalations;
      if (event.payload.confirmed !== undefined)
        s.run.amended_choices = [...(s.run.amended_choices ?? []), ...event.payload.confirmed];
      if (p.limits.max_wall_ms === null) {
        s.deadline_at = null;
        s.deadline_passed = false;
      }
      break;
    }
    case 'AmendmentRejected':
      break;

    case 'StepEntered':
      s.current_step = event.payload.step;
      s.step_visits[event.payload.step] = event.payload.visit;
      s.ci_polls = 0;
      break;
    case 'StepSkipped':
      s.current_step = event.payload.step;
      if (event.payload.kind === 'review')
        s.evidence.review_skipped.push({ revision: s.revision, valid: true });
      break;
    case 'StepExhausted':
      break;

    case 'AttemptRequested': {
      const p = event.payload;
      s.attempts[p.attempt_id] = {
        id: p.attempt_id,
        step: p.step,
        n: p.n,
        kind: p.kind,
        revision: s.revision,
        rung: p.rung,
        binding: p.binding,
        effect_id: p.effect_id,
        reservation_id: p.reservation_id,
        status: 'running',
        stop_requested: false,
        outcome: null,
        usage: null,
        ...(p.resumed_from === undefined ? {} : { resumed_from: p.resumed_from }),
      };
      s.current_attempt[p.step] = p.attempt_id;
      break;
    }
    case 'AttemptFinished': {
      const a = s.attempts[event.payload.attempt_id];
      if (a) {
        a.status = 'finished';
        a.outcome = {
          class: event.payload.class,
          status: event.payload.status,
          signature: event.payload.signature,
        };
        a.usage = event.payload.usage;
        if (event.payload.session_ref !== undefined) a.session_ref = event.payload.session_ref;
        if (event.payload.summary !== undefined) a.summary = event.payload.summary;
      }
      if (event.payload.status === 'done') s.last_fix_step = event.payload.step;
      break;
    }
    case 'RetryCountersCleared':
      for (const k of event.payload.counter_keys) delete s.class_counters[k];
      break;
    case 'FailureClassified': {
      const p = event.payload;
      s.class_counters[p.counter_key] = p.count;
      // Only quality classes touch the escalation streak (FR-019).
      if (p.rung !== null && (p.class === 'quality' || p.class === 'invalid_output')) {
        const k = streakKey(p.step, p.rung);
        const prev = s.failure_streaks[k];
        s.failure_streaks[k] = {
          signature: p.signature,
          consecutive: p.consecutive,
          quality_tries: (prev?.quality_tries ?? 0) + 1,
          escalate: p.escalate,
        };
      }
      // A timeout past its retries asks for the next rung without counting as a quality try (#247).
      if (p.rung !== null && p.class === 'timeout' && p.escalate) {
        const k = streakKey(p.step, p.rung);
        const prev = s.failure_streaks[k];
        s.failure_streaks[k] = {
          signature: prev?.signature ?? null,
          consecutive: prev?.consecutive ?? 0,
          quality_tries: prev?.quality_tries ?? 0,
          escalate: true,
        };
      }
      break;
    }

    case 'BudgetReserved': {
      const p = event.payload;
      s.budget.reservations[p.reservation_id] = {
        effect_id: p.effect_id,
        units: p.units,
        status: 'held',
      };
      s.budget.agent_runs.reserved += p.units;
      break;
    }
    case 'BudgetConsumed': {
      const r = s.budget.reservations[event.payload.reservation_id];
      if (r?.status === 'held') {
        r.status = 'consumed';
        s.budget.agent_runs.reserved -= r.units;
        s.budget.agent_runs.used += r.units;
      }
      break;
    }
    case 'BudgetReleased': {
      const r = s.budget.reservations[event.payload.reservation_id];
      if (r?.status === 'held') {
        r.status = 'released';
        s.budget.agent_runs.reserved -= r.units;
      }
      break;
    }

    case 'RungRaised':
      s.rungs.by_step[event.payload.step] = event.payload.to;
      s.budget.escalations.used += 1;
      if (!s.escalated_steps.includes(event.payload.step))
        s.escalated_steps.push(event.payload.step);
      break;
    case 'TaskFloorRaised':
      s.rungs.floor_level = event.payload.level;
      break;

    case 'GateResultRecorded':
      s.evidence.gates.push({
        revision: s.revision,
        step: event.payload.step,
        visit: event.payload.visit,
        passed: event.payload.passed,
        signature: event.payload.signature,
        valid: event.payload.discarded !== true,
        failed: event.payload.results
          .filter((r) => !r.passed)
          .map((r) => ({
            gate: r.gate,
            signature: r.signature ?? null,
            log_excerpt: r.log_excerpt ?? null,
          })),
      });
      resetStreak(s, event.payload.resets_streak_of);
      break;
    case 'ReviewVerdictRecorded':
      s.evidence.reviews.push({
        revision: s.revision,
        head_sha: event.payload.head_sha,
        verdict: event.payload.verdict,
        valid: true,
      });
      if (event.payload.input_digest !== undefined) {
        s.run.reviews.push({
          revision: s.revision,
          attempt_id: event.payload.attempt_id,
          verdict: event.payload.verdict,
          sha: event.payload.head_sha,
          input_digest: event.payload.input_digest,
          signature: event.payload.signature,
          findings: event.payload.findings ?? [],
          ...(event.payload.summary === undefined ? {} : { summary: event.payload.summary }),
          valid: true,
        });
        s.run.verdict_attempt_id = event.payload.attempt_id;
      }
      resetStreak(s, event.payload.resets_streak_of);
      break;
    case 'PrAdopted':
      s.adoption = event.payload.adoption;
      s.pr_ref = event.payload.adoption.pr_ref;
      s.head_sha = event.payload.adoption.head_sha;
      break;
    case 'PublishRecorded':
      s.evidence.publishes.push({
        revision: s.revision,
        head_sha: event.payload.head_sha,
        valid: true,
      });
      s.head_sha = event.payload.head_sha;
      break;
    case 'CiResultRecorded':
      s.evidence.ci.push({
        revision: s.revision,
        head_sha: event.payload.head_sha,
        required_set: event.payload.required_set,
        checks: event.payload.checks,
        ...(event.payload.required === undefined ? {} : { required: event.payload.required }),
        valid: true,
      });
      resetStreak(s, event.payload.resets_streak_of);
      break;
    case 'BaseRelationRecorded':
      s.evidence.base_relations.push({
        ...event.payload.relation,
        revision: s.revision,
        valid: true,
      });
      break;
    case 'EvidenceInvalidated': {
      const rev = event.payload.revision;
      const ev = s.evidence;
      for (const list of [
        ev.gates,
        ev.reviews,
        ev.review_skipped,
        ev.ci,
        ev.base_relations,
        ev.publishes,
      ]) {
        for (const e of list) if (e.revision === rev) e.valid = false;
      }
      for (const id of event.payload.approvals) {
        const a = s.approvals[id];
        if (a) a.revoked = true;
      }
      break;
    }

    case 'EffectRequested': {
      const p = event.payload;
      s.effects[p.effect_id] = {
        id: p.effect_id,
        kind: p.kind,
        idem_key: p.idem_key,
        status: 'pending',
        revision: s.revision,
        step: p.step,
        attempt_id: p.attempt_id,
        reservation_id: p.reservation_id,
        target_effect_id: p.target_effect_id,
        ...(p.request['base_update'] === undefined
          ? {}
          : { base_update: BaseUpdateSchema.parse(p.request['base_update']) }),
      };
      if (p.kind === 'await_ci') {
        s.ci_polls += 1;
        const head = p.request['head_sha'];
        if (s.runtime_ref !== null && typeof head === 'string') {
          const w = s.run.ci_wait[head];
          s.run.ci_wait[head] = {
            started_at: w?.started_at ?? (p.request['at'] as number | undefined) ?? 0,
            polls: (w?.polls ?? 0) + 1,
          };
        }
      }
      if (p.kind === 'stop_attempt' && p.attempt_id !== null) {
        const a = s.attempts[p.attempt_id];
        if (a) a.stop_requested = true;
      }
      break;
    }
    case 'EffectStarted': {
      const e = s.effects[event.payload.effect_id];
      if (e) e.status = 'started';
      break;
    }
    case 'EffectCompleted': {
      const e = s.effects[event.payload.effect_id];
      if (e) {
        e.status = event.payload.status;
        if (event.payload.status === 'succeeded')
          applySuccessFacts(s, e.kind, event.payload.result);
        applyWorktreeTree(s, e.kind, event.payload.result);
      }
      break;
    }
    case 'EffectInvalidated': {
      const e = s.effects[event.payload.effect_id];
      if (e) e.status = 'invalidated';
      break;
    }
    case 'EffectReconciled': {
      const e = s.effects[event.payload.effect_id];
      if (e) {
        e.status = event.payload.status;
        if (event.payload.status === 'succeeded')
          applySuccessFacts(s, e.kind, event.payload.result);
        applyWorktreeTree(s, e.kind, event.payload.result);
      }
      break;
    }
    case 'ReconcileIncomplete':
      break;

    case 'TimerArmed': {
      const p = event.payload;
      s.timers[p.timer_id] = {
        id: p.timer_id,
        kind: p.kind,
        due_at: p.due_at,
        status: 'armed',
        payload: p.payload,
      };
      if (p.kind === 'deadline') {
        s.deadline_at = p.due_at;
        s.deadline_passed = false;
      }
      break;
    }
    case 'TimerCancelled': {
      const t = s.timers[event.payload.timer_id];
      if (t) t.status = 'cancelled';
      break;
    }
    case 'TimerFired': {
      const t = s.timers[event.payload.timer_id];
      if (t) {
        t.status = 'fired';
        if (t.kind === 'deadline') s.deadline_passed = true;
      }
      break;
    }

    case 'QuestionAsked': {
      const p = event.payload;
      s.questions[p.question_id] = {
        id: p.question_id,
        step: p.step,
        attempt_id: p.attempt_id,
        revision: s.revision,
        body: p.body,
        status: 'open',
        answer: null,
        answered_by: null,
        resume: p.resume,
      };
      break;
    }
    case 'QuestionAnswered': {
      const q = s.questions[event.payload.question_id];
      if (q) {
        q.status = 'answered';
        q.answer = event.payload.answer;
        q.answered_by = event.payload.by;
      }
      break;
    }
    case 'AnswerRejected':
      break;
    case 'DeciderRan': {
      const { attempt_id, ...run } = event.payload;
      s.decider_runs = { ...s.decider_runs, [attempt_id]: run };
      break;
    }
    case 'ApprovalRequested': {
      const p = event.payload;
      s.approvals[p.approval_id] = {
        id: p.approval_id,
        kind: p.kind,
        revision: s.revision,
        step: p.step,
        rung: p.rung,
        head_sha: p.head_sha,
        policy_hash: p.policy_hash,
        status: 'requested',
        granted_by: null,
        revoked: false,
      };
      break;
    }
    case 'ApprovalGranted': {
      const a = s.approvals[event.payload.approval_id];
      if (a) {
        a.status = 'granted';
        a.granted_by = event.payload.by;
        if (event.payload.content_digest !== undefined)
          a.content_digest = event.payload.content_digest;
      }
      break;
    }
    case 'ApprovalRejected': {
      const a = s.approvals[event.payload.approval_id];
      if (a) {
        a.status = 'rejected';
        a.granted_by = event.payload.by;
      }
      break;
    }

    case 'SourceDriftDetected': {
      const p = event.payload;
      // Further edits during source drift replace only the pending content, preserving the safe boundary.
      s.source_drift = s.source_drift
        ? {
            ...s.source_drift,
            pending_revision: p.pending_revision,
            task: p.task,
          }
        : {
            pending_revision: p.pending_revision,
            detected_at: p.at,
            safe_boundary_reached: false,
            task: p.task,
            deferred: null,
            prior_wait: null,
          };
      break;
    }
    case 'SafeBoundaryReached':
      if (s.source_drift) {
        s.source_drift.safe_boundary_reached = true;
        s.source_drift.deferred = event.payload.deferred;
        s.source_drift.prior_wait = event.payload.prior_wait;
      }
      break;
    case 'RevisionApplied':
      s.revision = event.payload.revision;
      s.task = event.payload.task;
      s.source_drift = null;
      s.current_attempt = {};
      s.ci_polls = 0;
      for (const q of Object.values(s.questions)) if (q.status === 'open') q.status = 'withdrawn';
      break;

    case 'CancelRequested':
      s.cancellation = {
        requested_at: event.payload.at,
        by: event.payload.by,
        reason: event.payload.reason,
        late: false,
        ...(event.payload.read_token === undefined ? {} : { read_token: event.payload.read_token }),
        // A merge already shown before the cancel counts the same as one shown after it.
        ...(event.payload.read_token !== undefined && s.observation?.last?.status === 'merged'
          ? { merge_seen: s.observation.last.observation_id }
          : {}),
      };
      s.source_drift = null;
      break;
    case 'CancelForced':
      if (s.cancellation) s.cancellation.forced = { by: event.payload.by, at: event.payload.at };
      break;
    case 'CancelReadFailed':
      if (s.cancellation) s.cancellation.reads = (s.cancellation.reads ?? 0) + 1;
      break;
    case 'CancelRecordedLate':
      if (s.cancellation) s.cancellation.late = true;
      break;

    case 'TaskCompleted':
      moveTo(s, 'DONE', event.type);
      s.wait = null;
      s.terminal = { kind: 'DONE', reason: event.payload.reason };
      break;
    case 'TaskFailed':
      moveTo(s, 'FAILED', event.type);
      s.wait = null;
      s.terminal = { kind: 'FAILED', reason: event.payload.reason };
      break;
    case 'TaskCancelled':
      moveTo(s, 'CANCELLED', event.type);
      s.wait = null;
      s.terminal = { kind: 'CANCELLED', reason: event.payload.reason };
      break;

    case 'SignalIgnored':
      break;

    case 'RuntimeConfigured':
      s.runtime_ref = {
        revision: event.payload.runtime.revision,
        hash: event.payload.runtime_hash,
      };
      s.run.mode = event.payload.runtime.run_config?.mode ?? null;
      s.run.frozen_digest = event.payload.runtime.run_config?.digest ?? null;
      s.run.limits = event.payload.runtime.limits;
      break;
    case 'ExecutionQueued': {
      const p = event.payload;
      s.execution.request = {
        request_id: p.request_id,
        requested_at: p.requested_at,
        // Commit order breaks ties between equal priorities and request times (SPEC.md §6.2).
        request_global_seq: 'global_seq' in event ? event.global_seq : 0,
        group: p.group,
        priority: p.priority,
        resume_action: p.resume_action,
      };
      break;
    }
    case 'ExecutionIntentUpdated': {
      const r = s.execution.request;
      if (r?.request_id === event.payload.request_id) {
        r.priority = event.payload.priority;
        r.resume_action = event.payload.resume_action;
      }
      break;
    }
    case 'ExecutionWithdrawn': {
      const r = s.execution.request;
      if (r?.request_id === event.payload.request_id) {
        s.execution.accumulated_wait_ms += Math.max(0, event.payload.at - r.requested_at);
        s.execution.request = null;
      }
      break;
    }
    case 'ExecutionGranted': {
      const r = s.execution.request;
      if (r?.request_id === event.payload.request_id) {
        s.execution.accumulated_wait_ms += Math.max(0, event.payload.at - r.requested_at);
        s.execution.request = null;
      }
      s.execution.holding = {
        request_id: event.payload.request_id,
        granted_at: event.payload.at,
        ...(event.payload.lender_task_id === undefined
          ? {}
          : { lender_task_id: event.payload.lender_task_id }),
      };
      break;
    }
    case 'ExecutionReleased':
      if (s.execution.holding?.request_id === event.payload.request_id) s.execution.holding = null;
      break;
    case 'ExecutionReserved':
      if (s.execution.holding?.request_id === event.payload.request_id)
        s.execution.holding.reserved_at = event.payload.at;
      break;
    case 'ExecutionReclaimed':
      if (s.execution.holding?.request_id === event.payload.request_id)
        delete s.execution.holding.reserved_at;
      break;
    case 'OperationRegistered': {
      const p = event.payload;
      s.operations[p.operation_id] = {
        id: p.operation_id,
        effect_id: p.effect_id,
        attempt_id: p.attempt_id,
        kind: p.kind,
        revision: s.revision,
        launch_nonce: p.launch_nonce,
        unit: p.unit,
        holds_slot: p.holds_slot,
        status: 'registered',
        outcome: null,
        invocation_id: null,
        processes: [],
        registered_at: p.at,
        started_at: null,
        finished_at: null,
        cursor: null,
        artifact_ids: [],
      };
      break;
    }
    case 'OperationObserved': {
      const o = s.operations[event.payload.operation_id];
      if (o) {
        const p = event.payload;
        o.status = p.status;
        o.outcome = p.outcome;
        o.invocation_id = p.invocation_id;
        o.processes = p.processes;
        o.started_at = p.started_at;
        o.finished_at = p.finished_at;
      }
      break;
    }
    case 'OutputIngested': {
      const o = s.operations[event.payload.operation_id];
      if (o) o.cursor = event.payload.cursor;
      break;
    }
    case 'ArtifactIngested': {
      const a = event.payload.artifact;
      s.artifacts[a.artifact_id] = a;
      const o = s.operations[a.operation_id];
      if (o && !o.artifact_ids.includes(a.artifact_id)) o.artifact_ids.push(a.artifact_id);
      break;
    }
    case 'ObservationScheduled': {
      const p = event.payload;
      const prev = s.observation;
      // The total window and round cap are fixed by the first schedule; later ones only move the cadence.
      s.observation = {
        subject: p.subject,
        budget: {
          started_at: prev?.budget.started_at ?? p.started_at,
          deadline_at: prev?.budget.deadline_at ?? p.deadline_at,
          count: prev?.budget.count ?? 0,
          max_count: prev?.budget.max_count ?? p.max_count,
          next_due_at: p.next_due_at,
          cadence_index: p.cadence_index,
          generation: p.generation,
          last_remote_digest: prev?.budget.last_remote_digest ?? null,
          exhausted: prev?.budget.exhausted ?? false,
        },
        last: prev?.last ?? null,
        expired: prev?.expired ?? false,
      };
      break;
    }
    case 'ExternalStateObserved': {
      const c = s.cancellation;
      const read = event.payload.observation;
      // The cancel's own read counts. A read of any source that shows a merge, proven or not, is kept
      // for good: no open/closed read logged later, its own late answer included, ends the cancel over
      // it; only the merge proof (DONE through the drain) does (FR-025.03/04, FR-040.12).
      if (c?.read_token !== undefined) {
        if (read.status === 'merged') c.merge_seen = read.observation_id;
        if (read.raw_evidence_ref === cancelReadRef(c.read_token)) {
          c.reads = (c.reads ?? 0) + 1;
          c.pr_read = {
            observation_id: read.observation_id,
            status: read.status,
            ...(event.payload.target === undefined ? {} : { target: event.payload.target }),
          };
        }
      }
      const o = s.observation;
      if (o) {
        const ob = event.payload.observation;
        // Only automatic rounds count against the window and move the schedule; a recheck does neither.
        if (ob.source === 'timer') {
          o.budget.count += 1;
          o.budget.next_due_at = null;
          o.budget.last_remote_digest = event.payload.remote_digest as Hash;
        }
        o.last = {
          observation_id: ob.observation_id,
          status: ob.status,
          observed_head: ob.observed_head,
          observed_at: ob.observed_at,
        };
      }
      // A merge GitHub reported holds the task until its proof is accepted, whatever later reads show (FR-040.12).
      if (event.payload.observation.status === 'merged' && s.completion === null) {
        addBlocker(s, {
          code: 'merge_evidence_incomplete',
          source: 'observation',
          since: event.payload.observation.observed_at,
          until: null,
        });
      }
      break;
    }
    case 'ObservationExpired':
      if (s.observation) {
        s.observation.expired = true;
        s.observation.budget.exhausted = true;
        s.observation.budget.next_due_at = null;
      }
      addBlocker(s, {
        code: 'observation_expired',
        source: event.payload.reason,
        since: event.payload.at,
        until: null,
      });
      break;
    case 'ObservationExtended':
      if (s.observation) {
        s.observation.budget.deadline_at = event.payload.deadline_at;
        s.observation.budget.max_count = event.payload.max_count;
      }
      break;
    case 'ExternalCompletionObserved':
      s.completion = {
        proof: event.payload.proof,
        unverified:
          event.payload.unverified_reason === null
            ? null
            : { reason: event.payload.unverified_reason },
        recorded_at: event.payload.at,
        drain: {
          started_at: null,
          deadline_at: null,
          count: 0,
          max_rounds: 0,
          auto_exhausted: false,
          paused: false,
        },
        pending_operations: [],
        finalized_at: null,
      };
      s.merged = true;
      s.blockers = s.blockers.filter((b) => b.code !== 'merge_evidence_incomplete');
      break;
    case 'DrainStarted':
      if (s.completion) {
        const d = s.completion.drain;
        d.started_at = event.payload.at;
        d.deadline_at = event.payload.deadline_at;
        d.max_rounds = event.payload.max_rounds;
        s.completion.pending_operations = event.payload.pending_operations;
      }
      addBlocker(s, {
        code: 'merge_cleanup_pending',
        source: 'drain',
        since: event.payload.at,
        until: event.payload.deadline_at,
      });
      break;
    case 'DrainProgressed':
      if (s.completion) {
        s.completion.drain.count = event.payload.round;
        s.completion.drain.paused = false;
        s.completion.pending_operations = event.payload.pending_operations;
        if (event.payload.local !== undefined) s.completion.local_remainder = event.payload.local;
      }
      break;
    case 'DrainPaused':
      if (s.completion) {
        s.completion.drain.paused = true;
        if (event.payload.reason === 'round_limit') s.completion.drain.auto_exhausted = true;
      }
      break;
    case 'DrainFinished':
      if (s.completion) {
        s.completion.finalized_at = event.payload.at;
        s.completion.pending_operations = [];
      }
      s.blockers = s.blockers.filter((b) => b.code !== 'merge_cleanup_pending');
      break;
    case 'WorktreeChangeAccepted':
      s.run.worktree_tree = event.payload.tree;
      break;
    case 'VisitsCredited': {
      const prev = s.visit_credits?.[event.payload.step];
      const ns = event.payload.attempt_ids.map((id) => s.attempts[id]?.n ?? 0);
      s.visit_credits = {
        ...s.visit_credits,
        [event.payload.step]: {
          visits: (prev?.visits ?? 0) + event.payload.attempt_ids.length,
          through: Math.max(prev?.through ?? 0, ...ns),
        },
      };
      break;
    }
    case 'TaskPaused':
      s.pause = { reason: event.payload.reason, by: event.payload.by, at: event.payload.at };
      if (event.payload.stopped !== undefined && event.payload.stopped.length > 0)
        s.pause_stops = [...(s.pause_stops ?? []), ...event.payload.stopped];
      break;
    case 'TaskUnpaused':
      s.pause = null;
      break;
    case 'TaskMessageSent': {
      const p = event.payload;
      s.messages = [
        ...(s.messages ?? []),
        {
          id: p.message_id,
          body: p.body,
          by: p.by,
          at: p.at,
          revision: p.revision,
          behavior: p.behavior,
          delivery: p.delivery,
        },
      ];
      if (p.stopped !== undefined && p.stopped.length > 0)
        s.message_stops = [...(s.message_stops ?? []), ...p.stopped];
      break;
    }
    case 'TaskContinued': {
      for (const k of event.payload.streaks) {
        const streak = s.failure_streaks[k];
        if (streak === undefined) continue;
        streak.signature = null;
        streak.consecutive = 0;
        streak.quality_tries = 0;
        streak.escalate = false;
      }
      const credits = { ...s.visit_credits };
      for (const [step, n] of Object.entries(event.payload.visits)) {
        const prev = credits[step];
        credits[step] = {
          visits: (prev?.visits ?? 0) + n,
          through: prev?.through ?? 0,
        };
      }
      s.visit_credits = credits;
      break;
    }
    case 'AnswerTurnGranted': {
      const streak = s.failure_streaks[event.payload.streak];
      if (streak !== undefined) {
        streak.escalate = false;
        streak.quality_tries = event.payload.quality_tries;
      }
      if (event.payload.auto === true)
        s.auto_turns = [...(s.auto_turns ?? []), event.payload.streak];
      break;
    }
    case 'ManifestChangeAccepted':
      s.run.manifest_refs = {
        ...s.run.manifest_refs,
        [event.payload.harness]: event.payload.manifest_hash,
      };
      break;
    case 'RecheckRequested':
      // A recheck of a paused drain allows one more bounded round; the round and time caps stay.
      if (
        event.payload.target === 'drain' &&
        s.completion !== null &&
        s.completion.finalized_at === null
      )
        s.completion.drain.paused = false;
      break;
    case 'RunConfigProposed':
      s.run.proposal = {
        selection: event.payload.selection,
        digest: event.payload.digest,
        by: event.payload.by,
        at: event.payload.at,
      };
      break;
    case 'RunConfigConfirmed':
      s.run.confirmation = event.payload.confirmation;
      break;
    case 'CheckpointRecorded':
      s.run.checkpoint = event.payload.checkpoint;
      break;
    case 'MinorFixRecorded':
      s.run.minor_fix = event.payload.fix;
      break;
    case 'MinorFixStarted':
    case 'MinorFixDropped': {
      const started = s.run.minor_started ?? [];
      if (!started.includes(event.payload.review_attempt_id))
        s.run.minor_started = [...started, event.payload.review_attempt_id];
      if (event.type === 'MinorFixDropped' && event.payload.tree !== null)
        s.run.worktree_tree = event.payload.tree;
      break;
    }
    case 'FailureSalvageStarted':
      s.run.salvage = { reason: event.payload.reason };
      break;
    case 'PublishContentRecorded':
      s.run.content = event.payload.content;
      break;
    case 'ReviewReused':
      s.run.verdict_attempt_id = event.payload.from_attempt_id;
      break;
    case 'BaseUpdateRecorded':
      s.run.base_update = event.payload.update;
      if (event.payload.update.superseded_reads !== undefined)
        s.run.superseded_reads = [
          ...new Set([...(s.run.superseded_reads ?? []), ...event.payload.update.superseded_reads]),
        ];
      // A drift to the remote merge now taken as the base update is no longer unexplained (#110).
      if (
        event.payload.update.remote_head !== undefined &&
        s.run.head_drift?.observed === event.payload.update.remote_head
      ) {
        s.run.head_drift = null;
        s.blockers = s.blockers.filter((b) => b.code !== 'head_changed');
      }
      break;
    case 'HeadDriftRecorded':
      s.run.head_drift = event.payload.drift;
      addBlocker(s, {
        code: 'head_changed',
        source: event.payload.drift.source,
        since: event.payload.drift.at,
        until: null,
      });
      break;
    default:
      assertNever(event);
  }
  return s;
}

/** Runtime fields at their replay defaults: a v1 log never sets them, so a legacy task stays `runtime_ref = null`. */
export function emptyRuntime(): Pick<
  TaskState,
  | 'runtime_ref'
  | 'execution'
  | 'operations'
  | 'artifacts'
  | 'observation'
  | 'completion'
  | 'blockers'
  | 'run'
> {
  return {
    run: {
      proposal: null,
      confirmation: null,
      mode: null,
      frozen_digest: null,
      checkpoint: null,
      content: null,
      reviews: [],
      head_drift: null,
      limits: null,
      ci_wait: {},
      pr_body: null,
      worktree_tree: null,
    },
    runtime_ref: null,
    execution: { request: null, holding: null, accumulated_wait_ms: 0 },
    operations: {},
    artifacts: {},
    observation: null,
    completion: null,
    blockers: [],
  };
}

function addBlocker(s: TaskState, b: Blocker): void {
  if (!s.blockers.some((x) => x.code === b.code)) s.blockers.push(b);
}

/** A passing check clears the consecutive count at the step's current rung; rung and tries stay (SPEC.md §9.3). */
function resetStreak(s: TaskState, step: string | null): void {
  if (step === null) return;
  const streak = s.failure_streaks[streakKey(step, s.rungs.by_step[step] ?? 0)];
  if (streak === undefined) return;
  streak.consecutive = 0;
  streak.signature = null;
}

function applySuccessFacts(s: TaskState, kind: string, result: unknown): void {
  const r = (result ?? {}) as Record<string, unknown>;
  // `base_sha` marks a usable worktree; a failed setup leaves prepare to be retried.
  const setup = r['setup'] as { passed?: unknown } | undefined;
  if (kind === 'prepare' && typeof r['base_sha'] === 'string' && setup?.passed === true)
    s.base_sha = r['base_sha'];
  if ((kind === 'create_pr' || kind === 'publish') && typeof r['pr_ref'] === 'string')
    s.pr_ref = r['pr_ref'];
  const body = r['pr_body'] as PrBodyState | undefined;
  if (kind === 'create_pr' && body !== undefined) s.run.pr_body = body;
  if (kind === 'merge' && r['merged'] === true) s.merged = true;
  if (kind === 'mark_ready' && typeof r['ready_at'] === 'number') s.run.pr_ready_at = r['ready_at'];
  if (
    kind === 'post_review' &&
    typeof r['attempt_id'] === 'string' &&
    r['outcome'] !== 'not_posted'
  )
    s.run.posted_reviews = [...(s.run.posted_reviews ?? []), r['attempt_id']];
}

/**
 * The worktree tree an effect saw as the task's own (T072): what prepare left, what a worker attempt
 * left (failed ones too, since they may have written), and a gate tree that held still and matches its
 * checkpoint. A gate tree that moved or differs from its checkpoint is a wait, never a new baseline.
 */
function applyWorktreeTree(s: TaskState, kind: string, result: unknown): void {
  const r = (result ?? {}) as Record<string, unknown>;
  if (kind === 'prepare' || kind === 'start_agent') {
    if (typeof r['worktree_tree'] === 'string') s.run.worktree_tree = r['worktree_tree'];
    return;
  }
  if (kind !== 'run_gates' || typeof r['tree'] !== 'string') return;
  const cp = r['checkpoint'] as { tree?: unknown } | undefined;
  if (r['stable'] !== false && (cp === undefined || cp.tree === r['tree']))
    s.run.worktree_tree = r['tree'];
}

export function replay(events: readonly AnyEvent[]): TaskState | null {
  let s: TaskState | null = null;
  for (const e of events) s = applyInPlace(s, structuredClone(e));
  return s;
}
