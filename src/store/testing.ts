import Database from 'better-sqlite3';
import type { DomainEventDraft } from '../domain/event.ts';
import { appendEvents, project } from './accept.ts';
import { NO_CRASH, type CrashHook } from './crash.ts';
import { readTask } from './read.ts';
import { SqliteStore, type Store } from './index.ts';
import { openDatabase, prepareSchema } from './open.ts';

// Entry chỉ dành cho kiểm thử (contracts/core-api.md): ESLint cấm import file này từ src/** ngoài store.

export { CRASH_POINTS, type CrashHook, type CrashPoint } from './crash.ts';
export { SqliteStore } from './index.ts';

/**
 * Kho trên SQLite in-memory với cùng schema, unique constraint và code transaction như kho trên file
 * (R-09). Không có bằng chứng độ bền: chỉ dùng cho dedup, thứ tự, idempotency và bất biến quyết định.
 */
export function openMemoryStore(opts: { crash?: CrashHook } = {}): SqliteStore {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const prepared = prepareSchema(db);
  if (!prepared.ok)
    throw new Error(`openMemoryStore: ${prepared.error.code} ${prepared.error.detail}`);
  return new SqliteStore(db, opts.crash ?? NO_CRASH);
}

/** Kho trên file với hook lỗi tuỳ chọn thay cho `CUSR_CRASH_AT` (ép lỗi ghi ngay trong tiến trình test). */
export function openFileStoreForTest(
  path: string,
  opts: { busyTimeoutMs?: number; crash?: CrashHook } = {},
): SqliteStore {
  const db = openDatabase(path, opts);
  if (!db.ok) throw new Error(`openFileStoreForTest: ${db.error.code} ${db.error.detail}`);
  return new SqliteStore(db.value, opts.crash ?? NO_CRASH);
}

/**
 * Ghi thẳng sự kiện vào nhật ký qua cùng đường append + projection (như `Sim.inject`), để dựng trạng thái
 * mà `decide` không tự tạo ra, ví dụ effect pending của task đã kết thúc. Không qua `decide`.
 */
export function injectEvents(
  store: Store,
  taskId: string,
  drafts: readonly DomainEventDraft[],
): void {
  const db = storeDb(store);
  db.transaction(() => {
    const { state, events } = appendEvents(db, taskId, readTask(db, taskId), drafts, {
      dedup_key: null,
    });
    project(db, events, state, NO_CRASH);
  }).immediate();
}

export function storeDb(store: Store): Database.Database {
  if (!(store instanceof SqliteStore)) throw new Error('storeDb: không phải SqliteStore');
  return store.db;
}
