/**
 * PR observation service of the daemon (T061, FR-043.01–06, research R-04). Each round picks runtime
 * tasks whose observation window has an automatic round due, and for each one either expires the window
 * (`observation_due`, no I/O, when its deadline or round cap is behind it) or reads the PR once and
 * submits what it saw as facts bound to the window's generation. A round is bounded in time (the
 * snapshot's `observation_round_ms`) and in tasks; the GitHub port of each read carries the per-round
 * request/page/byte/send caps, and a Retry-After beyond them comes back unknown, so the engine schedules
 * the next round inside the window instead of retrying hot. Nothing here holds the execution slot or
 * calls an agent.
 *
 * Coalescing: a task has one read in flight at a time. Callers asking under the same evidence ref share
 * it; a caller with another ref waits for it and then reads under its own, because a cancel only counts
 * a read carrying its ref (#267). A task whose CI wait is polling (a started or still claimable `await_ci`, or an
 * armed `ci_poll` timer) is left to that wait, so two chains never observe the same PR at once. Facts carry
 * the generation they were read under; the engine ignores a round of a generation that moved on.
 *
 * A cancel waiting for its read of the PR is read here too, under its own ref, with a backoff: the read
 * the cancel request made may have failed, been cut short by a restart, or found no PR yet (#267).
 */
import type { Clock } from '../adapters/ports.ts';
import { recordCancelReadFailure } from '../application/cancel.ts';
import { submit } from '../application/triage.ts';
import { DEFAULT_RUNTIME_LIMITS, type Observation } from '../domain/runtime.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import type { TaskState } from '../domain/state.ts';
import { cancelReadEvidence } from '../engine/cancel.ts';
import { claimable } from '../engine/claim.ts';
import type { Trigger } from '../domain/trigger.ts';
import type { Uuid } from '../shared/brand.ts';
import type { AcceptOutcome, Store } from '../store/index.ts';

export type ObservedFacts = {
  readonly facts: readonly Trigger[];
  readonly failure: string | null;
};

export type ObserveFn = (
  taskId: string,
  evidenceRef: string,
  source: Observation['source'],
) => Promise<ObservedFacts>;

/** One read per task at a time; a caller under another ref reads after the one in flight. */
export class ObservationCoordinator {
  readonly #inflight = new Map<string, { ref: string; read: Promise<ObservedFacts> }>();
  readonly #observe: ObserveFn;

  constructor(observe: ObserveFn) {
    this.#observe = observe;
  }

  observe(
    taskId: string,
    evidenceRef: string,
    source: Observation['source'],
  ): Promise<ObservedFacts> {
    const last = this.#inflight.get(taskId);
    if (last !== undefined && last.ref === evidenceRef) return last.read;
    const settled = (): void => undefined;
    const before = last === undefined ? Promise.resolve() : last.read.then(settled, settled);
    const read = before.then(() => this.#observe(taskId, evidenceRef, source));
    const entry = { ref: evidenceRef, read };
    this.#inflight.set(taskId, entry);
    const done = (): void => {
      if (this.#inflight.get(taskId) === entry) this.#inflight.delete(taskId);
    };
    read.then(done, done);
    return read;
  }

  busy(taskId: string): boolean {
    return this.#inflight.has(taskId);
  }
}

export type ObservationDeps = {
  readonly store: Store;
  readonly clock: Clock;
  readonly coordinator: ObservationCoordinator;
  readonly newId: () => string;
  /** Tasks handled per round at most; the rest wait for the next round. */
  readonly max_tasks?: number;
  /** Runs after a read's facts committed, one task at a time; a failure is the caller's to report. */
  readonly afterRead?: (taskId: string) => Promise<void>;
  /** When each task's cancel read was last tried, kept across rounds for the backoff. */
  readonly cancelReadAt?: Map<string, number>;
};

/** Backoff between the daemon's reads for a waiting cancel, by the number of cancel reads recorded. */
export const CANCEL_READ_BACKOFF = { base_ms: 5_000, max_ms: 5 * 60_000 } as const;

export function cancelReadDelay(reads: number): number {
  return Math.min(CANCEL_READ_BACKOFF.max_ms, CANCEL_READ_BACKOFF.base_ms * 2 ** reads);
}

/** When the daemon reads the PR for `s`'s cancel next; null when the cancel needs no read. */
export function cancelReadDue(s: TaskState, lastTried: number | undefined): number | null {
  if (s.terminal !== null || cancelReadEvidence(s) === null) return null;
  return lastTried === undefined ? 0 : lastTried + cancelReadDelay(s.cancellation?.reads ?? 0);
}

const ids = (deps: { newId: () => string }): string[] =>
  Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId());

/** The CI wait of the task polls the PR itself; the observation stays out of its way. */
/**
 * Whether the CI wait is reading the PR itself. A pending poll counts only while it can be claimed: one a
 * blocker holds (an incomplete merge, the deadline) never runs, so the observation takes over (FR-041.01).
 */
function ciWaitPolling(s: TaskState, now: number): boolean {
  const awaiting = Object.values(s.effects).some(
    (e) =>
      e.kind === 'await_ci' &&
      (e.status === 'started' ||
        (e.status === 'pending' &&
          claimable(s, { id: e.id, kind: e.kind, revision: e.revision }, now, {
            require_runtime: true,
          }).ok)),
  );
  return (
    awaiting || Object.values(s.timers).some((t) => t.kind === 'ci_poll' && t.status === 'armed')
  );
}

export type DueKind = 'expire' | 'observe' | 'cancel';

/** Whether an automatic round of `s` is due at `now`, and what it is. */
export function observationDue(s: TaskState, now: number): DueKind | null {
  const ob = s.observation;
  if (
    s.runtime_ref === null ||
    s.terminal !== null ||
    s.completion !== null ||
    ob === null ||
    ob.expired
  )
    return null;
  const b = ob.budget;
  if (now >= b.deadline_at || b.count >= b.max_count) return 'expire';
  if (b.next_due_at === null || b.next_due_at > now) return null;
  if (ciWaitPolling(s, now)) return null;
  // Merged into another branch: final, nothing left to observe (FR-040.12).
  if (s.wait?.detail.code === 'target_mismatch' && s.wait.detail['merged'] === true) return null;
  return 'observe';
}

export type ObservationRoundReport = {
  readonly task_id: string;
  readonly kind: DueKind;
  readonly generation: number;
  readonly outcomes: readonly {
    readonly kind: Trigger['kind'];
    readonly outcome: AcceptOutcome | null;
  }[];
  readonly failure: string | null;
};

/** Tasks with an automatic round due now, oldest due first. A due cancel read goes before the window. */
export function dueTasks(
  store: Store,
  now: number,
  cancelReadAt: ReadonlyMap<string, number> = new Map(),
): { id: string; kind: DueKind; due: number }[] {
  const out: { id: string; kind: DueKind; due: number }[] = [];
  for (const id of store.taskIdsByStatus(['RUNNING', 'WAITING'])) {
    const s = store.readTask(id as Uuid);
    if (s === null) continue;
    const cancelDue = cancelReadDue(s, cancelReadAt.get(id));
    if (cancelDue !== null) {
      if (cancelDue <= now) out.push({ id, kind: 'cancel', due: cancelDue });
      continue;
    }
    const kind = observationDue(s, now);
    if (kind !== null) out.push({ id, kind, due: s.observation?.budget.next_due_at ?? now });
  }
  return out.sort((a, b) => a.due - b.due || (a.id < b.id ? -1 : 1));
}

/** One read of the PR for the task's waiting cancel, under the cancel's ref (FR-025.03). */
async function cancelRead(
  deps: ObservationDeps,
  s: TaskState,
  cancelReadAt: Map<string, number>,
): Promise<ObservationRoundReport> {
  const ref = cancelReadEvidence(s) as string;
  cancelReadAt.set(s.id, deps.clock.now());
  const read = await deps.coordinator.observe(s.id, ref, 'cancel');
  const nonce = deps.newId();
  const outcomes = read.facts.map((fact, i) => {
    const cur = deps.store.readTask(s.id as Uuid);
    const r = submit(deps.store, {
      task_id: s.id,
      dedup_key: `cancel-read:${s.id}:${nonce}:${i}`,
      trigger: fact,
      now: deps.clock.now(),
      ids: ids(deps),
      ...(cur === null ? {} : { expected_version: cur.version }),
    });
    return { kind: fact.kind, outcome: r.ok ? r.value : null };
  });
  const failed = recordCancelReadFailure(deps.store, {
    task_id: s.id,
    ref,
    facts: read.facts,
    failure: read.failure,
    dedup_key: `cancel-read:${s.id}:${nonce}:failed`,
    now: deps.clock.now(),
    ids: ids(deps),
  });
  if (failed !== null)
    outcomes.push({ kind: 'cancel_read_failed', outcome: failed.ok ? failed.value : null });
  return { task_id: s.id, kind: 'cancel', generation: 0, outcomes, failure: read.failure };
}

export async function observationRound(deps: ObservationDeps): Promise<ObservationRoundReport[]> {
  const started = deps.clock.now();
  const reports: ObservationRoundReport[] = [];
  const cancelReadAt = deps.cancelReadAt ?? new Map<string, number>();
  for (const id of cancelReadAt.keys()) {
    const s = deps.store.readTask(id as Uuid);
    if (s === null || cancelReadDue(s, undefined) === null) cancelReadAt.delete(id);
  }
  const due = dueTasks(deps.store, started, cancelReadAt).slice(0, deps.max_tasks ?? 100);
  for (const d of due) {
    const s = deps.store.readTask(d.id as Uuid);
    if (s === null) continue;
    const roundMs =
      s.run.limits?.observation_round_ms ?? DEFAULT_RUNTIME_LIMITS.observation_round_ms;
    if (deps.clock.now() - started >= roundMs) break;
    if (d.kind === 'cancel') {
      if (!deps.coordinator.busy(d.id)) reports.push(await cancelRead(deps, s, cancelReadAt));
      continue;
    }
    if (s.observation === null) continue;
    const generation = s.observation.budget.generation;
    if (d.kind === 'expire') {
      const r = submit(deps.store, {
        task_id: d.id,
        dedup_key: `obs-due:${d.id}:g${generation}:${s.observation.budget.count}`,
        trigger: { kind: 'observation_due' },
        now: deps.clock.now(),
        ids: ids(deps),
        expected_version: s.version,
      });
      reports.push({
        task_id: d.id,
        kind: d.kind,
        generation,
        outcomes: [{ kind: 'observation_due', outcome: r.ok ? r.value : null }],
        failure: r.ok ? null : r.error.code,
      });
      continue;
    }
    if (deps.coordinator.busy(d.id)) continue;
    const read = await deps.coordinator.observe(d.id, `observe:${d.id}:g${generation}`, 'timer');
    const outcomes: { kind: Trigger['kind']; outcome: AcceptOutcome | null }[] = [];
    read.facts.forEach((fact, i) => {
      const cur = deps.store.readTask(d.id as Uuid);
      const r = submit(deps.store, {
        task_id: d.id,
        dedup_key: `obs:${d.id}:g${generation}:${i}`,
        trigger: fact,
        now: deps.clock.now(),
        ids: ids(deps),
        ...(cur === null ? {} : { expected_version: cur.version }),
      });
      outcomes.push({ kind: fact.kind, outcome: r.ok ? r.value : null });
    });
    reports.push({
      task_id: d.id,
      kind: d.kind,
      generation,
      outcomes,
      failure: read.failure,
    });
    if (read.failure === null) await deps.afterRead?.(d.id);
  }
  return reports;
}
