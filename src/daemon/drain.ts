/**
 * Daemon side of the drain (T046, FR-040.04–09). One bounded round per task with a merge proof: every
 * operation the task still has open is inspected, and one that is still running is stopped (SIGTERM, a
 * 10 second grace, SIGKILL, then a 5 second check that the unit's cgroup is empty). The round reports
 * what is still unresolved as `drain_result`; operation receipts and effect results keep arriving
 * through their own facts, and the engine ends the task only when its own state shows nothing open.
 * Each round also reports the local remainder: worktree HEAD, uncommitted changes and commits the
 * remote branch lacks, kept as they are (FR-040.06). Nothing here retries a push, resets the worktree
 * or releases a claim it cannot prove.
 */
import type { LocalRemainderProbe } from '../adapters/git/reconcile.ts';
import type { Clock, ProcessPort, StopOutcome } from '../adapters/ports.ts';
import { submit } from '../application/triage.ts';
import { isUnresolved } from '../engine/runtime.ts';
import type { Uuid } from '../shared/brand.ts';
import type { AcceptOutcome, Store } from '../store/index.ts';

export const DRAIN_TERM_GRACE_MS = 10_000;
export const DRAIN_KILL_VERIFY_MS = 5_000;

export type DrainDeps = {
  readonly store: Store;
  readonly process: ProcessPort;
  readonly clock: Clock;
  /** Reads what the task's worktree still holds (FR-040.06); never changes it. */
  readonly local?: (taskId: string) => Promise<LocalRemainderProbe | null>;
};

export type DrainRound = {
  readonly task_id: string;
  readonly stops: readonly {
    readonly operation_id: string;
    readonly outcome: StopOutcome | 'not_running';
  }[];
  readonly pending_operations: readonly string[];
  readonly local: LocalRemainderProbe | null;
  readonly outcome: AcceptOutcome | null;
};

/** Tasks whose drain is running: proof recorded, not finished, not paused (a paused one waits for recheck). */
export function drainingTasks(store: Store): string[] {
  return store.taskIdsByStatus(['WAITING', 'RUNNING']).filter((id) => {
    const c = store.readTask(id as Uuid)?.completion ?? null;
    return c !== null && c.finalized_at === null && c.drain.started_at !== null && !c.drain.paused;
  });
}

export async function drainRound(deps: DrainDeps, taskId: string): Promise<DrainRound | null> {
  const s = deps.store.readTask(taskId as Uuid);
  const c = s?.completion ?? null;
  if (s === null || c === null || c.finalized_at !== null || c.drain.paused) return null;
  const stops: {
    operation_id: string;
    outcome: StopOutcome | 'not_running';
  }[] = [];
  const pending: string[] = [];
  for (const op of Object.values(s.operations).filter(isUnresolved)) {
    const unit = await deps.process.inspect(op.id);
    if (unit.state === 'active') {
      const outcome = await deps.process.stop(op.id, {
        term_grace_ms: DRAIN_TERM_GRACE_MS,
        kill_verify_ms: DRAIN_KILL_VERIFY_MS,
      });
      stops.push({ operation_id: op.id, outcome });
    } else {
      stops.push({
        operation_id: op.id,
        outcome: unit.state === 'unknown' ? 'unknown' : 'not_running',
      });
    }
    // Stopped or not, the operation stays pending until its receipt resolves it in the engine.
    pending.push(op.id);
  }
  const local = (await deps.local?.(taskId)) ?? null;
  const after = deps.store.readTask(taskId as Uuid);
  const r = submit(deps.store, {
    task_id: taskId,
    dedup_key: `drain:${taskId}:${c.drain.count + 1}`,
    trigger: {
      kind: 'drain_result',
      pending_operations: pending.sort() as Uuid[],
      ...(local === null ? {} : { local }),
    },
    now: deps.clock.now(),
    ...(after === null ? {} : { expected_version: after.version }),
  });
  return {
    task_id: taskId,
    stops,
    pending_operations: pending,
    local,
    outcome: r.ok ? r.value : null,
  };
}
