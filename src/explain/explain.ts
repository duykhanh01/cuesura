import type { EpochMs, Uuid } from '../shared/brand.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import type { TaskState, TaskStatus, WaitReason } from '../domain/state.ts';
import { available } from '../engine/budget.ts';
import { isUnresolved } from '../engine/runtime.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
import { allowedActions, type AllowedAction } from './allowed-actions.ts';

export type Explanation = {
  status: TaskStatus;
  step: string | null;
  wait: {
    reason: WaitReason;
    detail: unknown;
    resume_when: string[];
    exit_paths: string[];
  } | null;
  /** `requested`: attempt được yêu cầu; `invoked`: lượt agent đã xác nhận chạy (giữ chỗ đã `consumed`). */
  bindings_used: {
    step: string;
    rung: number;
    binding: string;
    requested: number;
    invoked: number;
  }[];
  remaining: {
    agent_runs: number;
    reserved: number;
    wall_ms: number | null;
    escalations: number;
  };
  /**
   * Mỗi lần nâng nấc theo thứ tự nhật ký. `event_seq` là `seq` của `RungRaised`; `trigger_seq` là sự kiện đã
   * kích hoạt nó: `FailureClassified` xin nâng nấc (lý do `quality`) hoặc `TaskFloorRaised` (lý do `floor`).
   */
  escalations: {
    step: string;
    from: number;
    to: number;
    reason: string;
    signature: string | null;
    event_seq: number;
    trigger_seq: number | null;
  }[];
  pending_effects: {
    id: Uuid;
    kind: string;
    status: 'pending' | 'started' | 'unknown';
  }[];
  cancellation: { requested_at: EpochMs; late: boolean } | null;
};

/**
 * Giải thích trạng thái task chỉ từ dữ liệu đã ghi, không gọi LLM hay I/O (FR-034).
 * `now` là tuỳ chọn: lõi không đọc đồng hồ, nên thời gian còn lại tới `deadline_at` chỉ tính được khi người
 * gọi đưa thời điểm vào; không có `now` thì `remaining.wall_ms` là `null` trừ khi hạn đã qua hoặc chưa đặt.
 */
export function explain(
  state: TaskState,
  events: readonly DomainEvent[],
  policy: FrozenPolicy | null,
  now?: EpochMs,
): Explanation {
  return {
    status: state.status,
    step: state.current_step,
    wait:
      state.wait === null
        ? null
        : {
            reason: state.wait.reason,
            detail: state.wait.detail,
            resume_when: [...state.wait.resume_when],
            exit_paths: [...state.wait.exit_paths],
          },
    bindings_used: bindingsUsed(state, events),
    remaining: {
      agent_runs: available(state.budget),
      reserved: state.budget.agent_runs.reserved,
      wall_ms: remainingWall(state, policy, now),
      escalations:
        state.budget.escalations.limit - state.budget.escalations.used,
    },
    escalations: escalations(events),
    pending_effects: Object.values(state.effects)
      .flatMap((e) =>
        e.status === 'pending' ||
        e.status === 'started' ||
        e.status === 'unknown'
          ? [{ id: e.id as Uuid, kind: e.kind, status: e.status }]
          : [],
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    cancellation:
      state.cancellation === null
        ? null
        : {
            requested_at: state.cancellation.requested_at as EpochMs,
            late: state.cancellation.late,
          },
  };
}

/**
 * Gom attempt theo `(step, rung, binding)`, theo thứ tự `AttemptRequested` trong nhật ký: thứ tự key của
 * `state.attempts` không đáng tin vì kho lưu projection dạng JSON chuẩn hoá (key sắp theo ID).
 * `requested` đếm mọi attempt được yêu cầu; `invoked` chỉ đếm lượt đã xác nhận agent thật sự chạy, tức
 * giữ chỗ ngân sách đã chuyển sang `consumed` (FR-022).
 */
function bindingsUsed(
  state: TaskState,
  events: readonly DomainEvent[],
): Explanation['bindings_used'] {
  const groups = new Map<string, Explanation['bindings_used'][number]>();
  for (const e of events) {
    if (e.type !== 'AttemptRequested') continue;
    const p = e.payload;
    const reservation =
      state.attempts[p.attempt_id]?.reservation_id ?? p.reservation_id;
    const invoked =
      state.budget.reservations[reservation]?.status === 'consumed' ? 1 : 0;
    const key = `${p.step}#${p.rung}#${p.binding}`;
    const g = groups.get(key);
    if (g === undefined)
      groups.set(key, {
        step: p.step,
        rung: p.rung,
        binding: p.binding,
        requested: 1,
        invoked,
      });
    else {
      g.requested += 1;
      g.invoked += invoked;
    }
  }
  return [...groups.values()];
}

function remainingWall(
  state: TaskState,
  policy: FrozenPolicy | null,
  now: EpochMs | undefined,
): number | null {
  if (state.deadline_passed) return 0;
  if (state.deadline_at === null) return policy?.limits.max_wall_ms ?? null;
  if (now === undefined) return null;
  return Math.max(0, state.deadline_at - now);
}

function escalations(
  events: readonly DomainEvent[],
): Explanation['escalations'] {
  const out: Explanation['escalations'] = [];
  /** `FailureClassified` xin nâng nấc gần nhất theo `(step, rung)`. */
  const asks = new Map<string, number>();
  let floorSeq: number | null = null;
  for (const e of events) {
    if (
      e.type === 'FailureClassified' &&
      e.payload.escalate &&
      e.payload.rung !== null
    ) {
      asks.set(`${e.payload.step}#${e.payload.rung}`, e.seq);
    } else if (e.type === 'TaskFloorRaised') {
      floorSeq = e.seq;
    } else if (e.type === 'RungRaised') {
      const p = e.payload;
      const trigger =
        p.reason === 'floor'
          ? floorSeq
          : (asks.get(`${p.step}#${p.from}`) ?? null);
      out.push({
        step: p.step,
        from: p.from,
        to: p.to,
        reason: p.reason,
        signature: p.signature,
        event_seq: e.seq,
        trigger_seq: trigger,
      });
    }
  }
  return out;
}

/** Điều còn lại mà `explain()` lõi không biết: chỉ đọc state/log đã ghi và những gì người gọi đưa vào. */
export type RuntimeInput = {
  readonly now: EpochMs;
  readonly recheckable: boolean;
  readonly rt: FrozenRuntimeContext | null;
  /** Vị trí trong hàng chờ slot, 1 là kế tiếp; `null` khi không xếp hàng. */
  readonly queue_position: number | null;
  /** `null`: prerequisite ngoài phạm vi đọc của người gọi. */
  readonly prerequisite: (id: string) => TaskState | null;
  /** Phương thức/nội dung merge như `task show` đã dựng. */
  readonly merge: Record<string, unknown> | null;
};

export type RuntimeExplanation = Omit<Explanation, 'wait'> & {
  task_id: string;
  version: number;
  revision: number;
  /** `false`: chưa start, chưa có giới hạn đóng băng nên `remaining` chưa có nghĩa. */
  limits_frozen: boolean;
  /** Chỉ lý do; lối ra đọc ở `allowed_actions`, bản `resume_when` lõi còn nhắc amend của 001. */
  wait: { reason: WaitReason; detail: unknown } | null;
  allowed_actions: AllowedAction[];
  blockers: TaskState['blockers'];
  pr: {
    ref: string | null;
    head_sha: string | null;
    base_sha: string | null;
    observed: NonNullable<TaskState['observation']>['last'];
    observation_budget: NonNullable<TaskState['observation']>['budget'] | null;
    observation_expired: boolean;
  };
  deadline: {
    state: 'not_started' | 'running' | 'passed';
    at: number | null;
    remaining_ms: number | null;
    /** Trần khi chưa bắt đầu tính (READY chờ slot lần đầu chưa tiêu hạn). */
    max_wall_ms: number | null;
  };
  slot: {
    holding: boolean;
    queued: {
      group: string;
      requested_at: number;
      position: number | null;
    } | null;
    /** Chờ slot lần đầu: không tính vào deadline. */
    initial_wait_ms: number;
    /** Chờ xin lại sau khi đã chạy: có tính vào deadline. */
    resumed_wait_ms: number;
  };
  prerequisites: {
    task_id: string;
    status: TaskStatus | 'not_visible';
    unverified: { reason: string } | null;
    merged_head_sha: string | null;
    checked_head_sha: string | null;
    merge_commit_sha: string | null;
    evidence: string;
  }[];
  merge_cleanup: {
    merged_head_sha: string;
    pending_operations: { id: string; kind: string; status: string }[];
    unknown_effects: Explanation['pending_effects'];
    drain: NonNullable<TaskState['completion']>['drain'];
    recheck: boolean;
  } | null;
  merge: Record<string, unknown> | null;
  evidence: TaskState['evidence'];
};

/** Chờ slot tách theo nhóm: `ExecutionGranted.waited_ms` của từng request cộng phần request đang mở. */
function slotWaits(
  state: TaskState,
  events: readonly DomainEvent[],
  now: EpochMs,
): { initial: number; resumed: number } {
  const groups = new Map<string, string>();
  const waits = { initial: 0, resumed: 0 };
  const add = (group: string | undefined, ms: number): void => {
    if (group === 'fresh') waits.initial += ms;
    else waits.resumed += ms;
  };
  for (const e of events) {
    if (e.type === 'ExecutionQueued')
      groups.set(e.payload.request_id, e.payload.group);
    else if (e.type === 'ExecutionGranted')
      add(groups.get(e.payload.request_id), e.payload.waited_ms);
  }
  const open = state.execution.request;
  if (open !== null) add(open.group, Math.max(0, now - open.requested_at));
  return waits;
}

/**
 * `task explain` của runtime 002 (FR-027.03–05, FR-029): lối ra theo wait detail, blocker còn hiệu lực,
 * độ mới của quan sát, hạn, thời gian chờ slot, prerequisite chưa chứng nhận và drain sau merge. Chỉ đọc
 * dữ liệu đã ghi; không LLM, không I/O.
 */
export function explainRuntime(
  state: TaskState,
  events: readonly DomainEvent[],
  policy: FrozenPolicy | null,
  input: RuntimeInput,
): RuntimeExplanation {
  const core = explain(state, events, policy, input.now);
  const waits = slotWaits(state, events, input.now);
  const c = state.completion;
  const draining = c !== null && c.finalized_at === null;
  const request = state.execution.request;
  return {
    ...core,
    task_id: state.id,
    version: state.version,
    revision: state.revision,
    limits_frozen: policy !== null,
    wait:
      state.wait === null
        ? null
        : { reason: state.wait.reason, detail: state.wait.detail },
    allowed_actions: allowedActions(state, { recheckable: input.recheckable }),
    blockers: state.blockers.filter((b) => b.until === null),
    pr: {
      ref: state.pr_ref,
      head_sha: state.head_sha,
      base_sha: state.base_sha,
      observed: state.observation?.last ?? null,
      observation_budget: state.observation?.budget ?? null,
      observation_expired: state.observation?.expired ?? false,
    },
    deadline: {
      state: state.deadline_passed
        ? 'passed'
        : state.deadline_at === null
          ? 'not_started'
          : 'running',
      at: state.deadline_at,
      remaining_ms: core.remaining.wall_ms,
      max_wall_ms: policy?.limits.max_wall_ms ?? null,
    },
    slot: {
      holding: state.execution.holding !== null,
      queued:
        request === null
          ? null
          : {
              group: request.group,
              requested_at: request.requested_at,
              position: input.queue_position,
            },
      initial_wait_ms: waits.initial,
      resumed_wait_ms: waits.resumed,
    },
    prerequisites: state.task.depends_on.map((id) => {
      const p = input.prerequisite(id);
      const proof = p?.completion?.proof ?? null;
      return {
        task_id: id,
        status: p === null ? 'not_visible' : p.status,
        unverified: p?.completion?.unverified ?? null,
        merged_head_sha: proof?.merged_head_sha ?? null,
        checked_head_sha: proof?.checked_head_sha ?? null,
        merge_commit_sha: proof?.merge_commit_sha ?? null,
        evidence: `cusr task show ${id}`,
      };
    }),
    merge_cleanup: draining
      ? {
          merged_head_sha: c.proof.merged_head_sha,
          pending_operations: Object.values(state.operations)
            .filter(isUnresolved)
            .map((o) => ({ id: o.id, kind: o.kind, status: o.status })),
          unknown_effects: core.pending_effects,
          drain: c.drain,
          recheck: input.recheckable,
        }
      : null,
    merge: input.merge,
    evidence: state.evidence,
  };
}
