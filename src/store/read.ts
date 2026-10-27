import type { Database } from 'better-sqlite3';
import type { DomainEvent } from '../domain/event.ts';
import type { Effect } from '../domain/effect.ts';
import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
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

/** Effect chờ executor, theo thứ tự được yêu cầu. */
export function pendingEffects(db: Database, limit: number): Effect[] {
  const rows = db
    .prepare(`SELECT * FROM effects WHERE status = 'pending' ORDER BY created_seq LIMIT ?`)
    .all(limit) as EffectRow[];
  return rows.map(toEffect);
}
