/**
 * Daemon scheduler pass (T034, FR-044). One pass, in order:
 *   1. dependency notifications from committed prerequisite status (FR-001.02/03);
 *   2. queue every READY task that has not started as `fresh` (it stays READY, no deadline yet);
 *   3. let reservations held past `reservationMs` go, so their slot is free for the queue (FR-044.02);
 *   4. grant free slots, up to `concurrency`, to the queue head in turn (priority, resumed before fresh,
 *      request order);
 *   5. with every slot taken, lend each reservation not lent yet to a task that never started;
 *   In 4 and 5 a task that never started is passed over while its scope (changed files plus declared
 *   paths) shares a file with a task holding a slot or a loan (FR-044.08); one with an unknown scope is not.
 *   6. start every slot holder or borrower that is a fresh task, which freezes its snapshot under it.
 * A started task that needs the slot again queues itself as `resumed` inside the engine and resumes on
 * grant. The engine keeps the slot of a task that stops running to wait outside as a reservation, and
 * the task runs on it again as soon as it comes back. Nothing here preempts a holder or a borrower.
 */
import { runConfigConfirmed } from '../engine/run-config.ts';
import type { Clock } from '../adapters/ports.ts';
import { notifyDependents, type DependencyNotice } from '../application/dependency.ts';
import type { StartResult } from '../application/start.ts';
import { slotOccupants } from '../application/scope.ts';
import { submit } from '../application/triage.ts';
import { slotBlock, type ProjectScope } from '../application/scope-match.ts';
import { MAX_ENVELOPE_IDS, MAX_PASSED_OVER } from '../domain/trigger.ts';
import type { Uuid } from '../shared/brand.ts';
import type { QueuedRequest, Store } from '../store/index.ts';

/** How long a task whose start could not reach Git/GitHub/host waits before it queues again (FR-015). */
export const START_RETRY_MS = 60_000;

/** How long a task waiting outside keeps its slot reserved by default (FR-044.02): 24 hours. */
export const DEFAULT_RESERVATION_MS = 24 * 60 * 60 * 1000;

export type SchedulerDeps = {
  readonly store: Store;
  readonly clock: Clock;
  readonly start: (taskId: string) => Promise<StartResult>;
  /** IDs for the envelopes the scheduler submits (the queued request ID). */
  readonly newId: () => string;
  readonly startRetryMs?: number;
  /** True while `cusr queue pause` holds tasks that have not started (issue #142). */
  readonly queuePaused?: () => boolean;
  /** `runtime.concurrency`: how many tasks may hold a slot at once (FR-044.01); default 1. */
  readonly concurrency?: number;
  /** `runtime.slot_reservation_hours` in ms: how long a reservation lasts; default 24 hours. */
  readonly reservationMs?: number;
  /**
   * Effective scopes of these tasks, null where unknown (FR-044.08). Without it no task is passed over
   * for its scope.
   */
  readonly scopes?: (taskIds: readonly string[]) => Promise<ReadonlyMap<string, ProjectScope>>;
};

export type SchedulerReport = {
  readonly dependencies: readonly DependencyNotice[];
  readonly queued: readonly string[];
  readonly granted: readonly string[];
  /** Tasks granted a loan of a reservation in this pass. */
  readonly lent: readonly string[];
  /** Holders whose reservation ran out in this pass. */
  readonly expired: readonly string[];
  /** Tasks passed over for a slot or a loan in this pass because their scope overlaps (FR-044.08). */
  readonly passed_over: readonly string[];
  readonly started: readonly {
    readonly task_id: string;
    readonly result: StartResult;
  }[];
};

export class Scheduler {
  readonly #deps: SchedulerDeps;
  /** Task → time before which it is not queued again after an infrastructure failure at start. */
  readonly #retryAfter = new Map<string, number>();

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  async tick(): Promise<SchedulerReport> {
    const { store, clock } = this.#deps;
    const now = clock.now();
    const dependencies = notifyDependents(store, now);

    const paused = this.#deps.queuePaused?.() ?? false;
    const queued: string[] = [];
    for (const id of paused ? [] : store.taskIdsByStatus(['READY'])) {
      const s = store.readTask(id as Uuid);
      if (
        s === null ||
        s.policy_ref !== null ||
        s.execution.request !== null ||
        s.execution.holding !== null ||
        (s.pause ?? null) !== null
      )
        continue;
      // A fresh task queues only once its run selection is confirmed for this revision (M01/M02).
      if (!runConfigConfirmed(s)) continue;
      if ((this.#retryAfter.get(id) ?? 0) > now) continue;
      this.#retryAfter.delete(id);
      const r = submit(store, {
        task_id: id,
        dedup_key: `queue:${id}:v${s.version}`,
        trigger: { kind: 'request_execution' },
        now,
        ids: [this.#deps.newId()],
      });
      if (r.ok && r.value.decision.kind === 'accepted' && !r.value.duplicate) queued.push(id);
    }

    const capacity = this.#deps.concurrency ?? 1;
    const reservationMs = this.#deps.reservationMs ?? DEFAULT_RESERVATION_MS;
    const expired: string[] = [];
    for (const slot of store.readSlots()) {
      if (slot.reserved_at === null || slot.reserved_at + reservationMs > now) continue;
      // A holder running work that needs no slot (a CI poll) keeps it until it waits again.
      if (store.readTask(slot.holder_task_id as Uuid)?.status === 'RUNNING') continue;
      const r = submit(store, {
        task_id: slot.holder_task_id,
        dedup_key: `reservation-expired:${slot.request_id}:${slot.reserved_at}:${now}`,
        trigger: {
          kind: 'release_execution',
          request_id: slot.request_id as Uuid,
          reason: 'reservation_expired',
        },
        now,
        ids: [],
      });
      if (r.ok && !store.readSlots().some((x) => x.request_id === slot.request_id))
        expired.push(slot.holder_task_id);
    }

    const blocked = await this.#scopeGuard(capacity, paused);
    const passedOver = new Set<string>();
    const guard = (): { fresh: boolean; passedOver?: ReadonlySet<string> } => {
      const hit = blocked();
      for (const r of hit) passedOver.add(r.task_id);
      // Too many to name in one trigger: no fresh task is granted this pass rather than a blocked one.
      if (hit.length > MAX_PASSED_OVER) return { fresh: false };
      return { fresh: !paused, passedOver: new Set(hit.map((r) => r.request_id)) };
    };

    const granted: string[] = [];
    // Each grant takes one slot, so the loop ends after at most `capacity` grants; a rejected or empty
    // grant ends it too, and the next pass tries again.
    while (store.readSlots().length < capacity) {
      const g = store.grantNext(
        now,
        Array.from({ length: MAX_ENVELOPE_IDS }, () => this.#deps.newId()),
        { capacity, ...guard() },
      );
      if (!g.ok || g.value.kind !== 'decided' || g.value.outcome.decision.kind !== 'accepted')
        break;
      granted.push(g.value.task_id);
    }

    // Each loan takes one reservation and loans never exceed `capacity`, so this loop is bounded too.
    const lent: string[] = [];
    while (!paused) {
      const g = store.lendNext(now, [], { capacity, ...guard() });
      if (!g.ok || g.value.kind !== 'decided' || g.value.outcome.decision.kind !== 'accepted')
        break;
      lent.push(g.value.task_id);
    }

    const started: { task_id: string; result: StartResult }[] = [];
    const holdings = [
      ...store.readSlots().map((x) => ({ task_id: x.holder_task_id, request_id: x.request_id })),
      ...store.readLoans().map((x) => ({ task_id: x.borrower_task_id, request_id: x.request_id })),
    ];
    for (const slot of holdings) {
      const holder = store.readTask(slot.task_id as Uuid);
      if (holder === null || holder.status !== 'READY' || holder.policy_ref !== null) continue;
      // A task granted the slot but never started (a crash between grant and start, or a pause made
      // while an earlier holder was starting) gives it back while the queue is paused, and is queued
      // again after the resume. Read the pause again for each: every start awaits preflight.
      if (this.#deps.queuePaused?.() ?? false) {
        submit(store, {
          task_id: holder.id,
          dedup_key: `queue-paused:${slot.request_id}`,
          trigger: {
            kind: 'release_execution',
            request_id: slot.request_id as Uuid,
            reason: 'queue_paused',
          },
          now,
          ids: [],
        });
        continue;
      }
      const result = await this.#deps.start(holder.id);
      if (result.kind === 'unavailable')
        this.#retryAfter.set(holder.id, clock.now() + (this.#deps.startRetryMs ?? START_RETRY_MS));
      started.push({ task_id: holder.id, result });
    }
    return {
      dependencies,
      queued,
      granted,
      lent,
      expired,
      passed_over: [...passedOver].filter((id) => !granted.includes(id) && !lent.includes(id)),
      started,
    };
  }

  /**
   * Reads the scopes once per pass, then answers which fresh requests overlap the current holders and
   * borrowers, so a task granted earlier in the pass, fresh or resumed, blocks the ones after it.
   */
  async #scopeGuard(capacity: number, paused: boolean): Promise<() => QueuedRequest[]> {
    const read = this.#deps.scopes;
    const { store } = this.#deps;
    const queue = store.readQueue(Number.MAX_SAFE_INTEGER);
    const occupants = slotOccupants(store);
    if (
      read === undefined ||
      paused ||
      !queue.some((r) => r.group === 'fresh') ||
      (occupants.length === 0 && (capacity === 1 || queue.length === 1))
    )
      return () => [];
    let scopes: ReadonlyMap<string, ProjectScope>;
    try {
      // Every queued task may become a holder in this pass, so each one's scope is read too.
      scopes = await read([...occupants, ...queue.map((r) => r.task_id)]);
    } catch {
      // Unreadable scopes are unknown, and an unknown scope blocks nothing.
      return () => [];
    }
    return () => {
      const holders = slotOccupants(store);
      return store
        .readQueue(Number.MAX_SAFE_INTEGER)
        .filter((r) => r.group === 'fresh' && slotBlock(r.task_id, scopes, holders) !== null);
    };
  }
}
