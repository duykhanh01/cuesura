import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import { openFileStoreForTest, storeDb, type CrashPoint } from '../../../src/store/testing.ts';
import { buildTask, freezeOk } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const TASK = buildTask({ description: 'x'.repeat(200_000) });

function snapshot(d: StoreDriver): string {
  const db = storeDb(d.store);
  const all = (t: string): unknown[] => db.prepare(`SELECT * FROM ${t}`).all();
  return canonicalJson(
    ['events', 'tasks', 'effects', 'timers', 'accepted_triggers', 'frozen_policies'].map(all),
  );
}

describe('Write failures return write_failed without state changes (T083, FR-033)', () => {
  const tmp = useTempDir();

  it('SQLITE_FULL do max_page_count → write_failed disk_full', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tmp())));
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    const before = snapshot(d);
    const db = storeDb(d.store);
    const pages = db.pragma('page_count', { simple: true }) as number;
    db.pragma(`max_page_count = ${pages}`);

    const r = d.send(TASK.id, { kind: 'start', freeze: freezeOk(TASK) });
    expect(r).toEqual({
      ok: false,
      error: { code: 'write_failed', cause: 'disk_full' },
    });
    expect(db.inTransaction).toBe(false);
    expect(snapshot(d)).toBe(before);

    db.pragma('max_page_count = 1073741823');
    const env = d.ops.at(-1);
    if (env?.op !== 'accept') throw new Error('envelope is missing');
    expect(d.deliver(env.envelope)).toMatchObject({
      ok: true,
      value: { duplicate: false, decision: { kind: 'accepted' } },
    });
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('a busy error injected during a transaction rolls back all writes', () => {
    for (const point of ['after_events', 'after_effects', 'before_commit'] as CrashPoint[]) {
      let armed = false;
      const store = openFileStoreForTest(dbPath(tmp()), {
        crash: (p) => {
          if (armed && p === point)
            throw new Database.SqliteError('database is locked', 'SQLITE_BUSY');
        },
      });
      const d = new StoreDriver(store);
      d.must(TASK.id, { kind: 'create_task', task: TASK });
      const before = snapshot(d);
      armed = true;
      expect(d.send(TASK.id, { kind: 'start', freeze: freezeOk(TASK) }), point).toEqual({
        ok: false,
        error: { code: 'write_failed', cause: 'busy' },
      });
      expect(snapshot(d), point).toBe(before);
      expect(d.task(TASK.id).status, point).toBe('READY');
      store.close();
    }
  });
});
