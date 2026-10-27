import { assertNever } from '../shared/assert-never.ts';
import type { DomainEvent, DomainEventDraft } from '../domain/event.ts';
import {
  isTerminal,
  STATE_SCHEMA_VERSION,
  streakKey,
  type TaskState,
  type TaskStatus,
} from '../domain/state.ts';

/** Sự kiện tạo cạnh chuyển trạng thái ngoài data-model.md "Chuyển trạng thái": lỗi lập trình. */
export class InvalidTransition extends Error {
  override name = 'InvalidTransition';
}

/**
 * Các cạnh hợp lệ (data-model.md, FR-009). Cạnh về chính nó (`WAITING → WAITING`, `PENDING → PENDING`)
 * là cập nhật lý do chờ. DONE/FAILED/CANCELLED không có cạnh ra.
 */
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
  if (!isAllowedEdge(s.status, to)) throw new InvalidTransition(`${type}: ${s.status} → ${to} không hợp lệ`);
  s.status = to;
}

type AnyEvent = DomainEvent | DomainEventDraft;

/** Áp một sự kiện lên `TaskState` (contracts/core-api.md). Không đổi `state` đầu vào. */
export function evolve(state: TaskState | null, event: AnyEvent): TaskState {
  return applyInPlace(state === null ? null : structuredClone(state), structuredClone(event));
}

/**
 * Bản sửa tại chỗ cho `decide`, vốn đã tự sao chép state một lần. Payload được giữ theo tham chiếu, nên
 * caller phải truyền bản sao riêng của sự kiện.
 */
export function applyInPlace(state: TaskState | null, event: AnyEvent): TaskState {
  if (state === null) {
    if (event.type !== 'TaskCreated') throw new InvalidTransition(`${event.type} trước TaskCreated`);
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
        decider_calls: { limit: 0, used: 0, reserved: 0 },
        escalations: { limit: 0, used: 0 },
        reservations: {},
      },
      effects: {},
      timers: {},
      questions: {},
      approvals: {},
      evidence: { gates: [], reviews: [], review_skipped: [], ci: [], base_relations: [], publishes: [] },
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
    };
  }

  const s = state;
  if (isTerminal(s.status) && event.type !== 'SignalIgnored') {
    throw new InvalidTransition(`${event.type} sau khi task đã kết thúc (${s.status})`);
  }
  s.version += 1;

  switch (event.type) {
    case 'TaskCreated':
      throw new InvalidTransition('TaskCreated cho task đã tồn tại');
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
      // Chọn tiếp tục revision cũ hoặc tạo task mới khép lại source drift (research R-16).
      if (event.payload.reason.startsWith('drift:')) s.source_drift = null;
      break;

    case 'PolicyFrozen': {
      const { policy, context } = event.payload;
      const first = s.policy_ref === null;
      s.policy_ref = { revision: policy.revision, hash: policy.policy_hash, version: policy.policy_version };
      s.context_ref = { revision: context.revision, hash: context.context_hash };
      if (first) {
        // Ngân sách gắn với task, không reset khi đổi revision (FR-011, FR-040).
        s.budget.agent_runs.limit = policy.limits.max_agent_runs;
        s.budget.decider_calls.limit = policy.limits.max_decider_calls;
        s.budget.escalations.limit = policy.limits.max_escalations;
      }
      if (s.status === 'READY') moveTo(s, 'RUNNING', event.type);
      break;
    }
    case 'PolicyAmended': {
      const p = event.payload.policy;
      s.policy_ref = { revision: p.revision, hash: p.policy_hash, version: p.policy_version };
      s.budget.agent_runs.limit = p.limits.max_agent_runs;
      s.budget.decider_calls.limit = p.limits.max_decider_calls;
      s.budget.escalations.limit = p.limits.max_escalations;
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
      if (event.payload.kind === 'review') s.evidence.review_skipped.push({ revision: s.revision, valid: true });
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
      };
      s.current_attempt[p.step] = p.attempt_id;
      break;
    }
    case 'AttemptFinished': {
      const a = s.attempts[event.payload.attempt_id];
      if (a) {
        a.status = 'finished';
        a.outcome = { class: event.payload.class, status: event.payload.status, signature: event.payload.signature };
        a.usage = event.payload.usage;
      }
      if (event.payload.status === 'done') s.last_fix_step = event.payload.step;
      break;
    }
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
      break;
    }

    case 'BudgetReserved': {
      const p = event.payload;
      s.budget.reservations[p.reservation_id] = { effect_id: p.effect_id, units: p.units, status: 'held' };
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
      if (!s.escalated_steps.includes(event.payload.step)) s.escalated_steps.push(event.payload.step);
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
        valid: true,
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
      resetStreak(s, event.payload.resets_streak_of);
      break;
    case 'PublishRecorded':
      s.evidence.publishes.push({ revision: s.revision, head_sha: event.payload.head_sha, valid: true });
      s.head_sha = event.payload.head_sha;
      break;
    case 'CiResultRecorded':
      s.evidence.ci.push({
        revision: s.revision,
        head_sha: event.payload.head_sha,
        required_set: event.payload.required_set,
        checks: event.payload.checks,
        valid: true,
      });
      resetStreak(s, event.payload.resets_streak_of);
      break;
    case 'BaseRelationRecorded':
      s.evidence.base_relations.push({ ...event.payload.relation, revision: s.revision, valid: true });
      break;
    case 'EvidenceInvalidated': {
      const rev = event.payload.revision;
      const ev = s.evidence;
      for (const list of [ev.gates, ev.reviews, ev.review_skipped, ev.ci, ev.base_relations, ev.publishes]) {
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
      };
      if (p.kind === 'await_ci') s.ci_polls += 1;
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
        if (event.payload.status === 'succeeded') applySuccessFacts(s, e.kind, event.payload.result);
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
        if (event.payload.status === 'succeeded') applySuccessFacts(s, e.kind, event.payload.result);
      }
      break;
    }
    case 'ReconcileIncomplete':
      break;

    case 'TimerArmed': {
      const p = event.payload;
      s.timers[p.timer_id] = { id: p.timer_id, kind: p.kind, due_at: p.due_at, status: 'armed', payload: p.payload };
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
      // Sửa yêu cầu lần nữa khi drift còn mở chỉ thay nội dung chờ áp; ranh giới an toàn giữ nguyên.
      s.source_drift = s.source_drift
        ? { ...s.source_drift, pending_revision: p.pending_revision, task: p.task }
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
      s.cancellation = { requested_at: event.payload.at, by: event.payload.by, reason: event.payload.reason, late: false };
      s.source_drift = null;
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
    default:
      assertNever(event);
  }
  return s;
}

/** Dữ kiện mà kết quả thành công của effect để lại trên task (worktree, PR, merge). */
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
  if (kind === 'prepare' && typeof r['base_sha'] === 'string') s.base_sha = r['base_sha'];
  if (kind === 'create_pr' && typeof r['pr_ref'] === 'string') s.pr_ref = r['pr_ref'];
  if (kind === 'merge' && r['merged'] === true) s.merged = true;
}

/** Dựng lại state từ nhật ký (FR-029). */
export function replay(events: readonly AnyEvent[]): TaskState | null {
  let s: TaskState | null = null;
  for (const e of events) s = applyInPlace(s, structuredClone(e));
  return s;
}
