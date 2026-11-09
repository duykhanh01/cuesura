import Database from 'better-sqlite3';
import type { DomainEventDraft } from '../domain/event.ts';
import { appendEvents, project } from './accept.ts';
import { NO_CRASH, type CrashHook } from './crash.ts';
import { readTask } from './read.ts';
import { SqliteStore, type Store } from './index.ts';
import { openDatabase, prepareSchema } from './open.ts';

export { CRASH_POINTS, type CrashHook, type CrashPoint } from './crash.ts';
export { SqliteStore } from './index.ts';

/** Use the same schema and transactions as the file store. In-memory tests cannot prove durability. */
export function openMemoryStore(opts: { crash?: CrashHook } = {}): SqliteStore {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const prepared = prepareSchema(db);
  if (!prepared.ok)
    throw new Error(`openMemoryStore: ${prepared.error.code} ${prepared.error.detail}`);
  return new SqliteStore(db, opts.crash ?? NO_CRASH);
}

export function openFileStoreForTest(
  path: string,
  opts: { busyTimeoutMs?: number; crash?: CrashHook } = {},
): SqliteStore {
  const db = openDatabase(path, opts);
  if (!db.ok) throw new Error(`openFileStoreForTest: ${db.error.code} ${db.error.detail}`);
  return new SqliteStore(db.value, opts.crash ?? NO_CRASH);
}

/** Inject through append/projection without decide to construct otherwise unreachable test states. */
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
  if (!(store instanceof SqliteStore)) throw new Error('storeDb: expected a SqliteStore instance');
  return store.db;
}
