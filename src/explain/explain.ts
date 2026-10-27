import type { EpochMs, Uuid } from '../shared/brand.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import type { TaskState, TaskStatus, WaitReason } from '../domain/state.ts';
import { available } from '../engine/budget.ts';

export type Explanation = {
  status: TaskStatus;
  step: string | null;
  wait: { reason: WaitReason; detail: unknown; resume_when: string[]; exit_paths: string[] } | null;
  bindings_used: { step: string; rung: number; binding: string; attempts: number }[];
  remaining: { agent_runs: number; reserved: number; wall_ms: number | null; escalations: number };
  /**
   * Mỗi lần nâng nấc theo thứ tự nhật ký. `event_seq` là `seq` của `RungRaised`; `trigger_seq` là sự kiện đã
   * kích hoạt nó: `FailureClassified` xin nâng nấc (lý do `quality`) hoặc `TaskFloorRaised` (lý do `floor`).
   */
  escalations: { step: string; from: number; to: number; reason: string; signature: string | null; event_seq: number; trigger_seq: number | null }[];
  pending_effects: { id: Uuid; kind: string; status: 'pending' | 'started' | 'unknown' }[];
  cancellation: { requested_at: EpochMs; late: boolean } | null;
};

/**
 * Giải thích trạng thái task chỉ từ dữ liệu đã ghi, không gọi LLM hay I/O (FR-034).
 * `now` là tuỳ chọn: lõi không đọc đồng hồ, nên thời gian còn lại tới `deadline_at` chỉ tính được khi người
 * gọi đưa thời điểm vào; không có `now` thì `remaining.wall_ms` là `null` trừ khi hạn đã qua hoặc chưa đặt.
 */
export function explain(state: TaskState, events: readonly DomainEvent[], policy: FrozenPolicy | null, now?: EpochMs): Explanation {
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
    bindings_used: bindingsUsed(state),
    remaining: {
      agent_runs: available(state.budget),
      reserved: state.budget.agent_runs.reserved,
      wall_ms: remainingWall(state, policy, now),
      escalations: state.budget.escalations.limit - state.budget.escalations.used,
    },
    escalations: escalations(events),
    pending_effects: Object.values(state.effects)
      .flatMap((e) => (e.status === 'pending' || e.status === 'started' || e.status === 'unknown' ? [{ id: e.id as Uuid, kind: e.kind, status: e.status }] : []))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    cancellation: state.cancellation === null ? null : { requested_at: state.cancellation.requested_at as EpochMs, late: state.cancellation.late },
  };
}

/** Gom attempt theo `(step, rung, binding)`, theo thứ tự attempt đầu tiên của mỗi nhóm. */function bindingsUsed(state: TaskState): Explanation['bindings_used'] {
  const groups = new Map<string, Explanation['bindings_used'][number]>();
  // `attempts` giữ thứ tự chèn, tức thứ tự `AttemptRequested` trong nhật ký.
  for (const a of Object.values(state.attempts)) {
    const key = `${a.step}#${a.rung}#${a.binding}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { step: a.step, rung: a.rung, binding: a.binding, attempts: 1 });
    else g.attempts += 1;
  }
  return [...groups.values()];
}

function remainingWall(state: TaskState, policy: FrozenPolicy | null, now: EpochMs | undefined): number | null {
  if (state.deadline_passed) return 0;
  if (state.deadline_at === null) return policy?.limits.max_wall_ms ?? null;
  if (now === undefined) return null;
  return Math.max(0, state.deadline_at - now);
}

function escalations(events: readonly DomainEvent[]): Explanation['escalations'] {
  const out: Explanation['escalations'] = [];
  /** `FailureClassified` xin nâng nấc gần nhất theo `(step, rung)`. */
  const asks = new Map<string, number>();
  let floorSeq: number | null = null;
  for (const e of events) {
    if (e.type === 'FailureClassified' && e.payload.escalate && e.payload.rung !== null) {
      asks.set(`${e.payload.step}#${e.payload.rung}`, e.seq);
    } else if (e.type === 'TaskFloorRaised') {
      floorSeq = e.seq;
    } else if (e.type === 'RungRaised') {
      const p = e.payload;
      const trigger = p.reason === 'floor' ? floorSeq : (asks.get(`${p.step}#${p.from}`) ?? null);
      out.push({ step: p.step, from: p.from, to: p.to, reason: p.reason, signature: p.signature, event_seq: e.seq, trigger_seq: trigger });
    }
  }
  return out;
}
