import type { Database } from 'better-sqlite3';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import {
  computeRequestHash,
  TRIGGER_SCHEMA_VERSION,
  type TriggerEnvelope,
} from '../domain/trigger.ts';
import { accept, type AcceptError, type AcceptOutcome } from './accept.ts';
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

/** Lỗi khi bắn timer: lỗi của timer gặp lỗi cùng các tín hiệu đã commit trước đó trong lượt này. */
export type FireError = AcceptError & { fired: AcceptOutcome[] };

/**
 * Bắn các timer đến hạn, mỗi timer một transaction `accept` với khoá `timer:<id>`; `TimerFired` nằm
 * trong cùng transaction đó. Chạy lại sau crash không tạo tín hiệu thứ hai nhờ dedup. Dừng ở lỗi đầu
 * tiên và trả lỗi đó (FR-033); timer chưa xử lý giữ `armed` cho lần sau. Thiếu ID (`id_pool_exhausted`)
 * không ghi dedup nên timer vẫn đến hạn ở lần gọi sau.
 */
export function fireDueTimers(
  db: Database,
  now: number,
  limit: number,
  ids: (timerId: Uuid) => Uuid[],
  crash: CrashHook,
): Result<AcceptOutcome[], FireError> {
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
    if (!r.ok) return err({ ...r.error, fired: out });
    out.push(r.value);
  }
  return ok(out);
}
