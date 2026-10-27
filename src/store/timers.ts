import type { Database } from 'better-sqlite3';
import type { Uuid } from '../shared/brand.ts';
import {
  computeRequestHash,
  TRIGGER_SCHEMA_VERSION,
  type TriggerEnvelope,
} from '../domain/trigger.ts';
import { accept, type AcceptOutcome } from './accept.ts';
import type { CrashHook } from './crash.ts';
import type { TimerRow } from './projector.ts';
import { toTimer, type Timer } from './read.ts';

/**
 * Timer `armed` đã đến hạn mà chưa có tín hiệu `timer:<id>` nào được chấp nhận: mỗi timer tạo tối đa
 * một tín hiệu (FR-030), kể cả khi task đã kết thúc và timer không bao giờ chuyển sang `fired`.
 */
export function dueTimers(db: Database, now: number, limit: number): Timer[] {
  const rows = db
    .prepare(
      `SELECT * FROM timers t
       WHERE t.status = 'armed' AND t.due_at <= ?
         AND NOT EXISTS (SELECT 1 FROM accepted_triggers a WHERE a.dedup_key = 'timer:' || t.id)
       ORDER BY t.due_at, t.id LIMIT ?`,
    )
    .all(now, limit) as TimerRow[];
  return rows.map(toTimer);
}

/**
 * Bắn các timer đến hạn, mỗi timer một transaction `accept` với khoá `timer:<id>`; `TimerFired` nằm
 * trong cùng transaction đó. Chạy lại sau crash không tạo tín hiệu thứ hai nhờ dedup. Dừng ở lỗi ghi
 * đầu tiên; timer chưa xử lý giữ `armed` cho lần sau.
 */
export function fireDueTimers(
  db: Database,
  now: number,
  limit: number,
  ids: (timerId: Uuid) => Uuid[],
  crash: CrashHook,
): AcceptOutcome[] {
  const out: AcceptOutcome[] = [];
  for (const t of dueTimers(db, now, limit)) {
    const base = {
      schema_version: TRIGGER_SCHEMA_VERSION,
      task_id: t.task_id as Uuid,
      dedup_key: `timer:${t.id}`,
      trigger: { kind: 'timer' as const, timer_id: t.id as Uuid },
    };
    const env = {
      ...base,
      request_hash: computeRequestHash(base),
      now,
      ids: ids(t.id as Uuid),
    } as TriggerEnvelope;
    const r = accept(db, env, crash);
    if (!r.ok) break;
    out.push(r.value);
  }
  return out;
}
