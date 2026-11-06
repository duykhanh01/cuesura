import type { Database } from 'better-sqlite3';
import type { DomainEvent } from '../domain/event.ts';
import type { Effect } from '../domain/effect.ts';
import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
import { orderQueue } from '../engine/execution-slot.ts';
import type { TaskState, TaskStatus } from '../domain/state.ts';
import type { EffectRow, TimerRow } from './projector.ts';

export type EventRow = {
  global_seq: number;
  task_id: string;
  seq: number;
  type: string;
  revision: number;
  schema_version: number;
  actor: string;
  dedup_key: string | null;
  claim: string | null;
  payload_json: string;
};

export type Timer = {
  id: string;
  task_id: string;
  due_at: number;
  kind: string;
  status: 'armed' | 'fired' | 'cancelled';
  payload: unknown;
};

export function toEvent(r: EventRow): DomainEvent {
  return {
    schema_version: r.schema_version,
    task_id: r.task_id,
    seq: r.seq,
    global_seq: r.global_seq,
    type: r.type,
    revision: r.revision,
    actor: r.actor,
    causation:
      r.claim === null ? { dedup_key: r.dedup_key } : { dedup_key: r.dedup_key, claim: r.claim },
    payload: JSON.parse(r.payload_json) as unknown,
  } as DomainEvent;
}

export function toEffect(r: EffectRow): Effect {
  return {
    id: r.id,
    task_id: r.task_id,
    revision: r.revision,
    kind: r.kind as Effect['kind'],
    idem_key: r.idem_key,
    status: r.status as Effect['status'],
    request: JSON.parse(r.request_json) as Record<string, unknown>,
    ...(r.result_json !== null ? { result: JSON.parse(r.result_json) as unknown } : {}),
    reservation_id: r.reservation_id,
  };
}

export function toTimer(r: TimerRow): Timer {
  return {
    id: r.id,
    task_id: r.task_id,
    due_at: r.due_at,
    kind: r.kind,
    status: r.status as Timer['status'],
    payload: JSON.parse(r.payload_json) as unknown,
  };
}

export function readTask(db: Database, taskId: string): TaskState | null {
  const row = db.prepare('SELECT state_json FROM tasks WHERE id = ?').get(taskId) as
    | { state_json: string }
    | undefined;
  return row === undefined ? null : (JSON.parse(row.state_json) as TaskState);
}

/** Task IDs in the given statuses, in ID order. */
export function taskIdsByStatus(db: Database, statuses: readonly TaskStatus[]): string[] {
  if (statuses.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id FROM tasks WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY id`,
    )
    .all(...statuses) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Which tasks a read covers; `projects: null` is every project. */
export type TaskFilter = {
  readonly projects: readonly string[] | null;
  readonly statuses: readonly TaskStatus[];
};

export type TaskOrder = 'oldest' | 'newest';

function filterSql(f: TaskFilter): { where: string; params: string[] } {
  const marks = (n: number): string => Array(n).fill('?').join(', ');
  const parts = [`status IN (${marks(f.statuses.length)})`];
  const params: string[] = [...f.statuses];
  if (f.projects !== null) {
    parts.push(`project IN (${marks(f.projects.length)})`);
    params.push(...f.projects);
  }
  return { where: parts.join(' AND '), params };
}

/**
 * One page of task IDs in ID order, without reading any task's state. IDs are UUIDv7, so `newest` lists the
 * most recently created first and `after` then moves toward older tasks.
 */
export function taskPage(
  db: Database,
  f: TaskFilter & {
    readonly after?: string;
    readonly limit: number;
    readonly order?: TaskOrder;
  },
): string[] {
  const { where, params } = filterSql(f);
  const newest = f.order === 'newest';
  const past = f.after === undefined ? '' : ` AND id ${newest ? '<' : '>'} ?`;
  const rows = db
    .prepare(
      `SELECT id FROM tasks WHERE ${where}${past} ORDER BY id${newest ? ' DESC' : ''} LIMIT ?`,
    )
    .all(...params, ...(f.after === undefined ? [] : [f.after]), f.limit) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

export function countTasksByStatus(
  db: Database,
  f: TaskFilter,
): Partial<Record<TaskStatus, number>> {
  const { where, params } = filterSql(f);
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE ${where} GROUP BY status`)
    .all(...params) as { status: TaskStatus; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Requests waiting for the slot, for tasks of these projects. */
export function queueLength(db: Database, projects: readonly string[] | null): number {
  const scope =
    projects === null ? '' : ` AND t.project IN (${Array(projects.length).fill('?').join(', ')})`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM execution_queue q JOIN tasks t ON t.id = q.task_id WHERE q.status = 'queued'${scope}`,
    )
    .get(...(projects ?? [])) as { n: number };
  return row.n;
}

/** Sequence number of the newest event; every change to any task moves it. */
export function lastGlobalSeq(db: Database): number {
  const row = db.prepare('SELECT MAX(global_seq) AS seq FROM events').get() as {
    seq: number | null;
  };
  return row.seq ?? 0;
}

/** The time a trigger carried; `null` when it is unknown or older logs did not record one. */
export function triggerTime(db: Database, dedupKey: string): number | null {
  const row = db
    .prepare(
      `SELECT json_extract(envelope_json, '$.now') AS now FROM accepted_triggers WHERE dedup_key = ?`,
    )
    .get(dedupKey) as { now: unknown } | undefined;
  return typeof row?.now === 'number' ? row.now : null;
}

export function readTaskStatus(db: Database, taskId: string): TaskStatus | 'missing' {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
    | { status: TaskStatus }
    | undefined;
  return row?.status ?? 'missing';
}

export function readEvents(db: Database, taskId: string, fromSeq = 1): DomainEvent[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE task_id = ? AND seq >= ? ORDER BY seq')
    .all(taskId, fromSeq) as EventRow[];
  return rows.map(toEvent);
}

export function readPolicy(
  db: Database,
  taskId: string,
  revision: number,
  policyVersion?: number,
): FrozenPolicy | null {
  const row = (
    policyVersion === undefined
      ? db
          .prepare(
            'SELECT policy_json FROM frozen_policies WHERE task_id = ? AND revision = ? ORDER BY policy_version DESC LIMIT 1',
          )
          .get(taskId, revision)
      : db
          .prepare(
            'SELECT policy_json FROM frozen_policies WHERE task_id = ? AND revision = ? AND policy_version = ?',
          )
          .get(taskId, revision, policyVersion)
  ) as { policy_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.policy_json) as FrozenPolicy);
}

export function readContext(
  db: Database,
  taskId: string,
  revision: number,
): FrozenExecutionContext | null {
  const row = db
    .prepare('SELECT context_json FROM frozen_contexts WHERE task_id = ? AND revision = ?')
    .get(taskId, revision) as { context_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.context_json) as FrozenExecutionContext);
}

export function pendingEffects(db: Database, limit: number, after?: string): Effect[] {
  const rows = (
    after === undefined
      ? db
          .prepare(`SELECT * FROM effects WHERE status = 'pending' ORDER BY created_seq LIMIT ?`)
          .all(limit)
      : db
          .prepare(
            `SELECT * FROM effects WHERE status = 'pending' AND created_seq > (SELECT created_seq FROM effects WHERE id = ?) ORDER BY created_seq LIMIT ?`,
          )
          .all(after, limit)
  ) as EffectRow[];
  return rows.map(toEffect);
}

/** One effect with its request, whatever its status (reconcile reads the effect it probes). */
export function readEffect(db: Database, id: string): Effect | null {
  const row = db.prepare(`SELECT * FROM effects WHERE id = ?`).get(id) as EffectRow | undefined;
  return row === undefined ? null : toEffect(row);
}

/** Slot holder and the next request by SPEC.md §6.2 order, read inside the caller's transaction. */
export function readExecutionFacts(
  db: Database,
  startedOnly = false,
): {
  slot: { holder_task_id: string; request_id: string } | null;
  queue_head: string | null;
} {
  const slot = db
    .prepare(`SELECT holder_task_id, request_id FROM execution_slot WHERE key = 'execution'`)
    .get() as { holder_task_id: string; request_id: string } | undefined;
  const head = readQueue(db).find((r) => !startedOnly || r.group !== 'fresh');
  return { slot: slot ?? null, queue_head: head?.request_id ?? null };
}

export type QueuedRequest = {
  request_id: string;
  task_id: string;
  group: 'fresh' | 'resumed';
  priority: number;
  requested_at: number;
  request_global_seq: number;
};

/** Open requests in the selector's order (`orderQueue`); at most one per task, so the whole queue is small. */
export function readQueue(db: Database, limit = Number.MAX_SAFE_INTEGER): QueuedRequest[] {
  const rows = db
    .prepare(
      `SELECT request_id, task_id, grp, priority, requested_at, request_global_seq FROM execution_queue WHERE status = 'queued'`,
    )
    .all() as (Omit<QueuedRequest, 'group'> & { grp: 'fresh' | 'resumed' })[];
  return orderQueue(rows.map(({ grp, ...r }) => ({ ...r, group: grp }))).slice(0, limit);
}

export function readSlot(
  db: Database,
): { holder_task_id: string; request_id: string; claimed_at: number } | null {
  const row = db
    .prepare(
      `SELECT holder_task_id, request_id, claimed_at FROM execution_slot WHERE key = 'execution'`,
    )
    .get() as { holder_task_id: string; request_id: string; claimed_at: number } | undefined;
  return row ?? null;
}

/** Every project path any snapshot froze; execution resolves a task's Git directories from it. */
export function frozenProjectPaths(db: Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(runtime_json, '$.project_path') AS path
       FROM runtime_contexts
       WHERE path IS NOT NULL
       ORDER BY path`,
    )
    .all() as { path: string }[];
  return rows.map((r) => r.path);
}

export function readRuntimeContext(
  db: Database,
  taskId: string,
  revision: number,
): FrozenRuntimeContext | null {
  const row = db
    .prepare('SELECT runtime_json FROM runtime_contexts WHERE task_id = ? AND revision = ?')
    .get(taskId, revision) as { runtime_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.runtime_json) as FrozenRuntimeContext);
}

export type UnresolvedOperation = {
  id: string;
  task_id: string;
  effect_id: string;
  status: string;
  holds_slot: boolean;
};

/** Operations not yet proven finished or never launched; startup reconciles these before granting work. */
export function unresolvedOperations(db: Database): UnresolvedOperation[] {
  const rows = db
    .prepare(
      `SELECT id, task_id, effect_id, status, holds_slot FROM operations WHERE status IN ('registered', 'running', 'unknown', 'lost') ORDER BY id`,
    )
    .all() as (Omit<UnresolvedOperation, 'holds_slot'> & {
    holds_slot: number;
  })[];
  return rows.map((r) => ({ ...r, holds_slot: r.holds_slot === 1 }));
}
