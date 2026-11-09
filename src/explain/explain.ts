import type { EpochMs, Uuid } from '../shared/brand.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import {
  isTerminal,
  type TaskMessage,
  type TaskPause,
  type TaskState,
  type TaskStatus,
  type WaitReason,
} from '../domain/state.ts';
import { available } from '../engine/budget.ts';
import { stepVisitLimit } from '../engine/interpreter.ts';
import { isUnresolved } from '../engine/runtime.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
import { allowedActions, type AllowedAction, type PrerequisiteState } from './allowed-actions.ts';
import { needsUser } from './needs-user.ts';

/** `cusr queue pause` in force, with what `status`, `explain`, `board` and `report` all show (#256). */
export type QueuePausedView = {
  reason: string;
  by: string;
  at: number;
  age_ms: number;
  command: 'cusr queue resume';
};

export function queuePausedView(
  p: { readonly reason: string; readonly by: string; readonly at: number } | null,
  now: number,
): QueuePausedView | null {
  return p === null
    ? null
    : { ...p, age_ms: Math.max(0, now - p.at), command: 'cusr queue resume' };
}

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
  /** Live tasks that wait on this one, directly or through another dependent. */
  readonly dependents: RuntimeExplanation['dependents'];

  readonly merge: Record<string, unknown> | null;
  /** When the task entered its current status; null when the log cannot say. */
  readonly status_since?: number | null;
  /** When a running attempt last wrote a log record; null when it wrote none or its log cannot be read. */
  readonly last_output_at?: (attemptId: string) => number | null;
  readonly queue_paused?: QueuePausedView | null;
  /** When a prerequisite entered its status, for a wait recorded without its own start (#249). */
  readonly prerequisite_since?: (s: TaskState) => number | null;
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
  /** The queue pause holding this task back; null once the task has started or when none is in force. */
  queue_paused: QueuePausedView | null;
  /** Messages of the current revision, in the order sent; later agent attempts carry them (issue #154). */
  messages: TaskMessage[];
  /** Blockers in force: without an end, or with one still ahead. */
  blockers: TaskState['blockers'];
  /** When the task entered its current status; null when the log cannot say. */
  status_since: number | null;
  /** Attempts launched and not yet finished: the worker or reviewer binding at work now. */
  running: {
    attempt_id: string;
    step: string;
    kind: string;
    rung: number;
    binding: string;
    /** When the runner started the attempt's process; null while no runner has taken it. */
    started_at: number | null;
    last_output_at: number | null;
    /**
     * Time since the attempt last showed life: its last output, else its start, else the task entering its
     * status. Grows while an attempt hangs, which the timestamps alone do not show (issue #264).
     */
    silent_ms: number | null;
  }[];
  /** Why the task ended; null while it is live. */
  terminal: TaskState['terminal'];
  /**
   * The merge the task finished on. `unverified` set means nobody checked the merged head, so a DONE does
   * not vouch for it.
   */
  completion: {
    merged_head_sha: string;
    checked_head_sha: string | null;
    merge_commit_sha: string | null;
    unverified: { reason: string } | null;
  } | null;
  pr: {
    ref: string | null;
    head_sha: string | null;
    base_sha: string | null;
    observed: NonNullable<TaskState['observation']>['last'];
    observation_budget: NonNullable<TaskState['observation']>['budget'] | null;
    observation_expired: boolean;
  };
  deadline: {
    /** `ended` once the task is terminal: nothing counts down any more. */
    state: 'not_started' | 'running' | 'passed' | 'ended';
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
    /** What the prerequisite waits on now; a paused or user-bound one holds this task back (#256). */
    wait_code: string | null;
    paused: boolean;
    needs_user: boolean;
    unverified: { reason: string } | null;
    merged_head_sha: string | null;
    checked_head_sha: string | null;
    merge_commit_sha: string | null;
    evidence: string;
  }[];
  /**
   * Live tasks that depend on this one, directly or through another dependent (`depends_on` names the
   * task they wait on). Ending FAILED or CANCELLED cancels every one of them (#249).
   */
  dependents: { task_id: string; status: TaskStatus; depends_on: string }[];
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

/** When the runner started the attempt's newest operation; null while none has started. */
function attemptStartedAt(state: TaskState, attemptId: string): number | null {
  let at: number | null = null;
  for (const o of Object.values(state.operations))
    if (o.attempt_id === attemptId && o.started_at !== null) at = Math.max(at ?? 0, o.started_at);
  return at;
}

/**
 * `detail.deps` of a dependency wait is what triage saw; the view shows each prerequisite as it stands
 * now, so a prerequisite that moved on is not reported as it was.
 */
function waitDetail(
  state: TaskState,
  prereqs: readonly { task_id: string; status: string }[],
): unknown {
  const d = state.wait?.detail;
  if (d?.code !== 'dependency_pending' || typeof d['deps'] !== 'object' || d['deps'] === null)
    return d;
  const now = new Map(prereqs.map((p) => [p.task_id, p.status]));
  const deps = Object.fromEntries(
    Object.entries(d['deps'] as Record<string, unknown>).map(([id, st]) => {
      const cur = now.get(id);
      return [id, cur === undefined || cur === 'not_visible' ? st : cur];
    }),
  );
  return { ...d, deps };
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
  const ended = isTerminal(state.status);
  const statusSince = input.status_since ?? null;
  const prereqs: (PrerequisiteState & {
    status: TaskStatus | 'not_visible';
    state: TaskState | null;
  })[] = state.task.depends_on.map((id) => {
    const p = input.prerequisite(id);
    return {
      task_id: id,
      status: p === null ? 'not_visible' : p.status,
      wait_code: p?.wait?.detail.code ?? null,
      paused: (p?.pause ?? null) !== null,
      needs_user:
        p !== null && needsUser(p, input.now, () => input.prerequisite_since?.(p) ?? null),
      state: p,
    };
  });
  const queuePaused = state.policy_ref === null && !ended ? (input.queue_paused ?? null) : null;
  return {
    ...core,
    task_id: state.id,
    version: state.version,
    revision: state.revision,
    limits_frozen: policy !== null,
    wait:
      state.wait === null
        ? null
        : { reason: state.wait.reason, detail: waitDetail(state, prereqs) },
    allowed_actions: allowedActions(state, {
      recheckable: input.recheckable,
      dependents: input.dependents.length,
      queuePaused: queuePaused !== null,
      prerequisites: prereqs,
    }),
    paused: state.pause ?? null,
    queue_paused: queuePaused,
    messages: (state.messages ?? []).filter((m) => m.revision === state.revision),
    blockers: state.blockers.filter((b) => b.until === null || b.until > input.now),
    status_since: statusSince,
    running: Object.values(state.attempts)
      .filter((a) => a.status === 'running')
      .sort((a, b) => a.n - b.n)
      .map((a) => {
        const started = attemptStartedAt(state, a.id);
        const output = input.last_output_at?.(a.id) ?? null;
        const alive = output ?? started ?? statusSince;
        return {
          attempt_id: a.id,
          step: a.step,
          kind: a.kind,
          rung: a.rung,
          binding: a.binding,
          started_at: started,
          last_output_at: output,
          silent_ms: alive === null ? null : Math.max(0, input.now - alive),
        };
      }),
    terminal: state.terminal,
    completion:
      c === null
        ? null
        : {
            merged_head_sha: c.proof.merged_head_sha,
            checked_head_sha: c.proof.checked_head_sha,
            merge_commit_sha: c.proof.merge_commit_sha,
            unverified: c.unverified,
          },
    pr: {
      ref: state.pr_ref,
      head_sha: state.head_sha,
      base_sha: state.base_sha,
      observed: state.observation?.last ?? null,
      observation_budget: state.observation?.budget ?? null,
      observation_expired: state.observation?.expired ?? false,
    },
    deadline: {
      state: ended
        ? 'ended'
        : state.deadline_passed
          ? 'passed'
          : state.deadline_at === null
            ? 'not_started'
            : 'running',
      at: state.deadline_at,
      remaining_ms: ended ? null : core.remaining.wall_ms,
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
    prerequisites: prereqs.map(
      ({ task_id: id, state: p, status, wait_code, paused, needs_user }) => {
        const proof = p?.completion?.proof ?? null;
        return {
          task_id: id,
          status,
          wait_code,
          paused,
          needs_user,
          unverified: p?.completion?.unverified ?? null,
          merged_head_sha: proof?.merged_head_sha ?? null,
          checked_head_sha: proof?.checked_head_sha ?? null,
          merge_commit_sha: proof?.merge_commit_sha ?? null,
          evidence: `cusr task show ${id}`,
        };
      },
    ),
    dependents: [...input.dependents],
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
