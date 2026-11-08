import type { EpochMs, Uuid } from '../shared/brand.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import type { TaskPause, TaskState, TaskStatus, WaitReason } from '../domain/state.ts';
import { available } from '../engine/budget.ts';
import { stepVisitLimit } from '../engine/interpreter.ts';
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
  /** requested counts scheduled attempts; invoked counts consumed reservations proving an actual run. */
  bindings_used: {
    step: string;
    rung: number;
    binding: string;
    requested: number;
    invoked: number;
  }[];
  /**
   * Visits of each step entered so far against its limit (`max_visits` plus granted extra visits); null
   * when the step has none. A review/fix loop shows here before the step is exhausted.
   */
  visits: { step: string; visits: number; limit: number | null }[];
  remaining: {
    agent_runs: number | null;
    reserved: number;
    wall_ms: number | null;
    escalations: number | null;
  };
  /**
   * Rung raises follow event order. trigger_seq identifies the FailureClassified or TaskFloorRaised
   * event that caused one.
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
 * Explain recorded facts without I/O. Callers supply now; without it, remaining wall time is
 * unknown unless the deadline is absent or already elapsed.
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
    visits: stepVisits(state, policy),
    remaining: {
      agent_runs: state.budget.agent_runs.limit === null ? null : available(state.budget),
      reserved: state.budget.agent_runs.reserved,
      wall_ms: remainingWall(state, policy, now),
      escalations:
        state.budget.escalations.limit === null
          ? null
          : state.budget.escalations.limit - state.budget.escalations.used,
    },
    escalations: escalations(events),
    pending_effects: Object.values(state.effects)
      .flatMap((e) =>
        e.status === 'pending' || e.status === 'started' || e.status === 'unknown'
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

/** Steps entered so far, in workflow order, with the limit the interpreter enforces. */
function stepVisits(state: TaskState, policy: FrozenPolicy | null): Explanation['visits'] {
  const order = [...Object.keys(policy?.workflow.steps ?? {}), ...Object.keys(state.step_visits)];
  return [...new Set(order)]
    .filter((step) => (state.step_visits[step] ?? 0) > 0)
    .map((step) => ({
      step,
      visits: state.step_visits[step] ?? 0,
      limit: policy === null ? null : stepVisitLimit(policy, state, step),
    }));
}

/**
 * Group attempts by step, rung, and binding in AttemptRequested event order. Projection keys are
 * sorted by ID and cannot establish execution order. Invoked counts only consumed reservations.
 */
function bindingsUsed(
  state: TaskState,
  events: readonly DomainEvent[],
): Explanation['bindings_used'] {
  const groups = new Map<string, Explanation['bindings_used'][number]>();
  for (const e of events) {
    if (e.type !== 'AttemptRequested') continue;
    const p = e.payload;
    const reservation = state.attempts[p.attempt_id]?.reservation_id ?? p.reservation_id;
    const invoked = state.budget.reservations[reservation]?.status === 'consumed' ? 1 : 0;
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

function escalations(events: readonly DomainEvent[]): Explanation['escalations'] {
  const out: Explanation['escalations'] = [];

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

export type RuntimeInput = {
  readonly now: EpochMs;
  readonly recheckable: boolean;
  readonly rt: FrozenRuntimeContext | null;
  /** Queue position is 1-based; null means the task is not queued. */
  readonly queue_position: number | null;
  /** null means the prerequisite is outside the caller-readable evidence. */
  readonly prerequisite: (id: string) => TaskState | null;

  readonly merge: Record<string, unknown> | null;
};

export type RuntimeExplanation = Omit<Explanation, 'wait'> & {
  task_id: string;
  version: number;
  revision: number;
  /** Before start there are no frozen limits, so remaining values are not yet meaningful. */
  limits_frozen: boolean;
  /**
   * Read supported exits from allowed_actions; legacy resume_when may mention unimplemented
   * amendments.
   */
  wait: { reason: WaitReason; detail: unknown } | null;
  allowed_actions: AllowedAction[];
  /** Who paused the task, when and why; null when it is not paused (issue #142). */
  paused: TaskPause | null;
  blockers: TaskState['blockers'];
  /** Attempts launched and not yet finished: the worker or reviewer binding at work now. */
  running: {
    attempt_id: string;
    step: string;
    kind: string;
    rung: number;
    binding: string;
  }[];
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
    /**
     * Before first execution, show the full wall budget because slot waiting has not started the
     * deadline.
     */
    max_wall_ms: number | null;
  };
  slot: {
    holding: boolean;
    /**
     * How the task holds a slot (FR-044.07): `running` on its own, `reserved` while it waits outside (or
     * runs only work that needs no slot, such as a CI poll) and keeps it, `borrowed` on a loan of another
     * task's reservation; null when it holds none.
     */
    hold: {
      kind: 'running' | 'reserved' | 'borrowed';
      since: number;
      lender_task_id: string | null;
    } | null;
    queued: {
      group: string;
      requested_at: number;
      position: number | null;
    } | null;
    /** Initial slot waiting does not consume the task deadline. */
    initial_wait_ms: number;
    /** Reacquiring the slot after execution starts does consume the deadline. */
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

/**
 * Sum completed ExecutionGranted.waited_ms values and the currently open request separately by
 * wait group.
 */
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
    if (e.type === 'ExecutionQueued') groups.set(e.payload.request_id, e.payload.group);
    else if (e.type === 'ExecutionGranted')
      add(groups.get(e.payload.request_id), e.payload.waited_ms);
  }
  const open = state.execution.request;
  if (open !== null) add(open.group, Math.max(0, now - open.requested_at));
  return waits;
}

function slotHold(state: TaskState): RuntimeExplanation['slot']['hold'] {
  const h = state.execution.holding;
  if (h === null) return null;
  if (h.lender_task_id !== undefined)
    return { kind: 'borrowed', since: h.granted_at, lender_task_id: h.lender_task_id };
  if (h.reserved_at !== undefined)
    return { kind: 'reserved', since: h.reserved_at, lender_task_id: null };
  return { kind: 'running', since: h.granted_at, lender_task_id: null };
}

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
    wait: state.wait === null ? null : { reason: state.wait.reason, detail: state.wait.detail },
    allowed_actions: allowedActions(state, { recheckable: input.recheckable }),
    paused: state.pause ?? null,
    blockers: state.blockers.filter((b) => b.until === null),
    running: Object.values(state.attempts)
      .filter((a) => a.status === 'running')
      .sort((a, b) => a.n - b.n)
      .map((a) => ({
        attempt_id: a.id,
        step: a.step,
        kind: a.kind,
        rung: a.rung,
        binding: a.binding,
      })),
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
      hold: slotHold(state),
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
