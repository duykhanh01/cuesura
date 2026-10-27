import { describe, expect, it } from 'vitest';
import { openFileStoreForTest, openMemoryStore, storeDb } from '../../../src/store/testing.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { mixedWorkload } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

describe('verifyProjections (T079, FR-029)', () => {
  const tmp = useTempDir();

  it('khớp sau nhật ký nhiều task trên file thật', () => {
    const store = openFileStoreForTest(dbPath(tmp()));
    mixedWorkload(new StoreDriver(store));
    const report = store.verifyProjections();
    expect(report.mismatches).toEqual([]);
    expect(report).toMatchObject({ ok: true, tasks: 3 });
    expect(report.events).toBeGreaterThan(30);
    store.close();
  });

  it.each([
    ['tasks', `UPDATE tasks SET status = 'DONE' WHERE rowid = (SELECT min(rowid) FROM tasks)`],
    [
      'tasks',
      `UPDATE tasks SET state_json = replace(state_json, '"version":', '"version":1') WHERE rowid = (SELECT min(rowid) FROM tasks)`,
    ],
    ['effects', `UPDATE effects SET status = 'succeeded' WHERE status = 'pending'`],
    ['effects', `DELETE FROM effects WHERE rowid = (SELECT max(rowid) FROM effects)`],
    ['timers', `UPDATE timers SET due_at = due_at + 1`],
    ['task_deps', `DELETE FROM task_deps`],
    ['frozen_policies', `UPDATE frozen_policies SET policy_hash = 'sha256:00'`],
  ])('phát hiện dòng %s bị sửa tay', (table, sql) => {
    const store = openMemoryStore();
    mixedWorkload(new StoreDriver(store));
    expect(store.verifyProjections().ok).toBe(true);
    storeDb(store).exec(sql);
    const report = store.verifyProjections();
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((m) => m.table)).toContain(table);
  });

  it('phát hiện seq bị hở trong nhật ký', () => {
    const store = openMemoryStore();
    mixedWorkload(new StoreDriver(store));
    storeDb(store).exec(
      `UPDATE events SET seq = seq + 100 WHERE global_seq = (SELECT max(global_seq) FROM events)`,
    );
    expect(store.verifyProjections().mismatches.some((m) => m.table === 'events')).toBe(true);
  });
});
