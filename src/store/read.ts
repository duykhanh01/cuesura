import type { Database } from 'better-sqlite3';
import type { DomainEvent } from '../domain/event.ts';
import type { Effect } from '../domain/effect.ts';
import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
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
    { state_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.state_json) as TaskState);
}

export function readTaskStatus(db: Database, taskId: string): TaskStatus | 'missing' {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
    { status: TaskStatus } | undefined;
  return row?.status ?? 'missing';
}

export function readEvents(db: Database, taskId: string, fromSeq = 1): DomainEvent[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE task_id = ? AND seq >= ? ORDER BY seq')
    .all(taskId, fromSeq) as EventRow[];
  return rows.map(toEvent);
}

/** Chính sách của một revision; mặc định `policy_version` mới nhất. */
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

/** Effect chờ executor, theo thứ tự được yêu cầu; `after` (một effect id) cho trang tiếp theo. */
export function pendingEffects(db: Database, limit: number, after?: string): Effect[] {
  const rows = (
    after === undefined
      ? db.prepare(`SELECT * FROM effects WHERE status = 'pending' ORDER BY created_seq LIMIT ?`).all(limit)
      : db
          .prepare(
            `SELECT * FROM effects WHERE status = 'pending' AND created_seq > (SELECT created_seq FROM effects WHERE id = ?) ORDER BY created_seq LIMIT ?`,
          )
          .all(after, limit)
  ) as EffectRow[];
  return rows.map(toEffect);
}

/** Slot holder and the next request by SPEC.md §6.2 order, read inside the caller's transaction. */
export function readExecutionFacts(db: Database): {
  slot: { holder_task_id: string; request_id: string } | null;
  queue_head: string | null;
} {
  const slot = db.prepare(`SELECT holder_task_id, request_id FROM execution_slot WHERE key = 'execution'`).get() as
    { holder_task_id: string; request_id: string } | undefined;
  const head = readQueue(db, 1)[0];
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

/** Open requests in selection order: priority desc, resumed before fresh, request time, commit order. */
export function readQueue(db: Database, limit: number): QueuedRequest[] {
  const rows = db
    .prepare(
      `SELECT request_id, task_id, grp, priority, requested_at, request_global_seq FROM execution_queue
       WHERE status = 'queued' ORDER BY priority DESC, grp DESC, requested_at, request_global_seq LIMIT ?`,
    )
    .all(limit) as (Omit<QueuedRequest, 'group'> & { grp: 'fresh' | 'resumed' })[];
  return rows.map(({ grp, ...r }) => ({ ...r, group: grp }));
}

export function readSlot(db: Database): { holder_task_id: string; request_id: string; claimed_at: number } | null {
  const row = db.prepare(`SELECT holder_task_id, request_id, claimed_at FROM execution_slot WHERE key = 'execution'`).get() as
    { holder_task_id: string; request_id: string; claimed_at: number } | undefined;
  return row ?? null;
}

export function readRuntimeContext(db: Database, taskId: string, revision: number): FrozenRuntimeContext | null {
  const row = db.prepare('SELECT runtime_json FROM runtime_contexts WHERE task_id = ? AND revision = ?').get(taskId, revision) as
    { runtime_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.runtime_json) as FrozenRuntimeContext);
}

/** Operations not yet proven finished or never launched; startup reconciles these before granting work. */
export function unresolvedOperations(db: Database): { id: string; task_id: string; effect_id: string; status: string; holds_slot: boolean }[] {
  const rows = db
    .prepare(`SELECT id, task_id, effect_id, status, holds_slot FROM operations WHERE status IN ('registered', 'running', 'unknown', 'lost') ORDER BY id`)
    .all() as { id: string; task_id: string; effect_id: string; status: string; holds_slot: number }[];
  return rows.map((r) => ({ ...r, holds_slot: r.holds_slot === 1 }));
}
