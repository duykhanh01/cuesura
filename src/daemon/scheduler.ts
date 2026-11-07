/**
 * Daemon scheduler pass (T034, FR-044). One pass, in order:
 *   1. dependency notifications from committed prerequisite status (FR-001.02/03);
 *   2. queue every READY task that has not started as `fresh` (it stays READY, no deadline yet);
 *   3. grant free slots, up to `concurrency`, to the queue head in turn (priority, resumed before fresh,
 *      request order);
 *   4. start every slot holder that is a fresh task, which freezes its snapshot under the slot.
 * A started task that needs the slot again queues itself as `resumed` inside the engine and resumes on
 * grant; the engine also returns the slot once the task stops running to wait. Nothing here preempts a
 * holder.
 */
import { runConfigConfirmed } from '../engine/run-config.ts';
import type { Clock } from '../adapters/ports.ts';
import { notifyDependents, type DependencyNotice } from '../application/dependency.ts';
import type { StartResult } from '../application/start.ts';
import { submit } from '../application/triage.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

/** How long a task whose start could not reach Git/GitHub/host waits before it queues again (FR-015). */
export const START_RETRY_MS = 60_000;

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
};

export type SchedulerReport = {
  readonly dependencies: readonly DependencyNotice[];
  readonly queued: readonly string[];
  readonly granted: readonly string[];
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
    const granted: string[] = [];
    // Each grant takes one slot, so the loop ends after at most `capacity` grants; a rejected or empty
    // grant ends it too, and the next pass tries again.
    while (store.readSlots().length < capacity) {
      const g = store.grantNext(
        now,
        Array.from({ length: MAX_ENVELOPE_IDS }, () => this.#deps.newId()),
        { fresh: !paused, capacity },
      );
      if (!g.ok || g.value.kind !== 'decided' || g.value.outcome.decision.kind !== 'accepted')
        break;
      granted.push(g.value.task_id);
    }

    const started: { task_id: string; result: StartResult }[] = [];
    for (const slot of store.readSlots()) {
      const holder = store.readTask(slot.holder_task_id as Uuid);
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
    return { dependencies, queued, granted, started };
  }
}
