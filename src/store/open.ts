import Database from 'better-sqlite3';
import { err, ok, type Result } from '../shared/result.ts';
import { migrate, SCHEMA_VERSION } from './migrate.ts';

export type StoreOpenError = {
  code: 'store_locked' | 'schema_incompatible' | 'integrity_failed' | 'io_error';
  detail: string;
};

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  );
}

export function prepareSchema(db: Database.Database): Result<void, StoreOpenError> {
  const m = migrate(db);
  if (!m.ok)
    return err({
      code: 'schema_incompatible',
      detail: `Database schema version ${m.found} is newer than the supported version ${SCHEMA_VERSION}`,
    });
  const rows = db.pragma('integrity_check') as { integrity_check: string }[];
  const msgs = rows.map((r) => r.integrity_check);
  if (msgs.length !== 1 || msgs[0] !== 'ok')
    return err({ code: 'integrity_failed', detail: msgs.join('; ') });
  return ok(undefined);
}

/**
 * WAL with synchronous=FULL and a lifetime EXCLUSIVE lock. BEGIN IMMEDIATE acquires it at open; a
 * second writer gets SQLITE_BUSY/store_locked. The OS releases the lock if the process dies.
 */
export function openDatabase(
  path: string,
  opts: { busyTimeoutMs?: number } = {},
): Result<Database.Database, StoreOpenError> {
  let db: Database.Database;
  try {
    db = new Database(path);
  } catch (e) {
    return err({
      code: isBusy(e) ? 'store_locked' : 'io_error',
      detail: String(e),
    });
  }
  try {
    db.pragma(
      `busy_timeout = ${Math.max(0, Math.trunc(opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))}`,
    );
    db.pragma('locking_mode = EXCLUSIVE');
    const mode = db.pragma('journal_mode = WAL', { simple: true }) as string;
    if (mode.toLowerCase() !== 'wal')
      throw Object.assign(new Error(`journal_mode=${mode}`), {
        code: 'SQLITE_BUSY',
      });
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE; COMMIT');
    const prepared = prepareSchema(db);
    if (!prepared.ok) {
      db.close();
      return prepared;
    }
    return ok(db);
  } catch (e) {
    db.close();
    return err({
      code: isBusy(e) ? 'store_locked' : 'io_error',
      detail: String(e),
    });
  }
}
