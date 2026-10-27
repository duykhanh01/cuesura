import { describe, expect, it } from 'vitest';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openFileStoreForTest, openMemoryStore, storeDb } from '../../../src/store/testing.ts';
import { buildTask, freezeOk } from '../../support/builders.ts';
import { StoreDriver, timerIds } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';
import { runChild } from '../../support/child.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TASK = buildTask();
const WALL = 3_600_000;

function started(d: StoreDriver): void {
  d.must(TASK.id, { kind: 'create_task', task: TASK });
  d.must(TASK.id, { kind: 'start', freeze: freezeOk(TASK, { limits: { max_wall_ms: WALL } }) });
}

function timerSignals(d: StoreDriver): number {
  return (
    storeDb(d.store)
      .prepare(`SELECT count(*) AS n FROM accepted_triggers WHERE dedup_key LIKE 'timer:%'`)
      .get() as { n: number }
  ).n;
}

describe('Timer trong kho (T081)', () => {
  const tmp = useTempDir();

  it('fireDueTimers tạo đúng một tín hiệu logic; gọi lại không tạo thêm', () => {
    const d = new StoreDriver(openMemoryStore());
    started(d);
    expect(d.fire()).toEqual([]);
    d.now += WALL;
    const [deadline] = d.store.dueTimers(d.now as EpochMs, 10);
    expect(deadline?.kind).toBe('deadline');

    const fired = d.fire();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      dedup_key: `timer:${deadline?.id}`,
      duplicate: false,
      decision: { kind: 'accepted' },
    });
    expect(d.task(TASK.id).timers[deadline?.id ?? '']?.status).toBe('fired');
    expect(d.task(TASK.id).wait).toMatchObject({ reason: 'policy', detail: { code: 'deadline' } });

    expect(d.fire()).toEqual([]);
    expect(timerSignals(d)).toBe(1);
    // Gửi lại thủ công cùng khoá vẫn chỉ trả kết quả cũ.
    const env = d.envelope(
      TASK.id,
      { kind: 'timer', timer_id: deadline?.id as never },
      { dedup_key: `timer:${deadline?.id}` },
    );
    expect(d.deliver({ ...env, ids: timerIds(deadline?.id ?? '') })).toMatchObject({
      ok: true,
      value: { duplicate: true },
    });
    expect(timerSignals(d)).toBe(1);
  });

  it('now lùi so với lần trước: không timer nào đến hạn sớm, không lỗi', () => {
    const d = new StoreDriver(openMemoryStore());
    started(d);
    d.now += WALL - 1;
    expect(d.fire()).toEqual([]);
    d.now -= 10 * WALL;
    expect(d.fire()).toEqual([]);
    expect(d.store.dueTimers(d.now as EpochMs, 10)).toEqual([]);
    d.now += 11 * WALL;
    expect(d.fire()).toHaveLength(1);
  });

  it('crash ở after_commit khi bắn timer: chạy lại không tạo tín hiệu thứ hai', () => {
    const path = dbPath(tmp());
    const d = new StoreDriver(openFileStoreForTest(path));
    started(d);
    d.store.close();

    const ops = join(tmp(), 'ops.json');
    writeFileSync(ops, JSON.stringify([{ op: 'fire', now: d.now + WALL }]));
    const r = runChild(['apply', path, ops], { CUSR_CRASH_AT: 'after_commit' });
    expect(r.signal, JSON.stringify(r)).toBe('SIGKILL');

    const again = openFileStoreForTest(path);
    const d2 = new StoreDriver(again);
    d2.now = d.now + WALL;
    expect(timerSignals(d2)).toBe(1);
    expect(d2.fire()).toEqual([]);
    expect(timerSignals(d2)).toBe(1);
    expect(again.verifyProjections().ok).toBe(true);
    again.close();
  });
});
