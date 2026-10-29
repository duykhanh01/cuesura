import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Uuid } from '../../../src/shared/brand.ts';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import { openStore } from '../../../src/store/index.ts';
import {
  openFileStoreForTest,
  openMemoryStore,
  storeDb,
} from '../../../src/store/testing.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import { runChild } from '../../support/child.ts';
import {
  agentData,
  PREPARE_DATA,
  publishData,
} from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import {
  createAndStart,
  mixedWorkload,
  toPublish,
  WALL,
} from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const TASK = buildTask();

function counts(d: StoreDriver): {
  events: number;
  effects: number;
  timers: number;
} {
  const db = storeDb(d.store);
  const n = (t: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { events: n('events'), effects: n('effects'), timers: n('timers') };
}

function eventTypes(d: StoreDriver, taskId: string, fromSeq: number): string[] {
  return d.store.readEvents(taskId as Uuid, fromSeq).map((e) => e.type);
}

describe('US3: ghi nhận tín hiệu bền và đúng một lần (T085)', () => {
  const tmp = useTempDir();

  it('Scenario 1: gửi lại cùng tín hiệu → không có sự kiện, effect hay timer mới; trả kết quả lần đầu', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tmp())));
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    const env = d.envelope(TASK.id, { kind: 'start', freeze: freezeOk(TASK) });
    const first = d.deliver(env);
    const before = counts(d);
    expect(before.effects).toBeGreaterThan(0);
    expect(before.timers).toBeGreaterThan(0);
    const again = d.deliver(env);
    expect(counts(d)).toEqual(before);
    if (!first.ok || !again.ok) throw new Error('accept lỗi');
    expect(again.value.duplicate).toBe(true);
    expect(canonicalJson(again.value.decision)).toBe(
      canonicalJson(first.value.decision),
    );
    d.store.close();
  });

  it('Scenario 2: tiến trình bị ngắt giữa lúc ghi → mở lại thấy hoặc đủ hoặc không có gì', () => {
    const path = dbPath(tmp());
    const d = new StoreDriver(openFileStoreForTest(path));
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    const before = counts(d);
    const env = d.envelope(TASK.id, { kind: 'start', freeze: freezeOk(TASK) });
    d.store.close();

    const ops = join(tmp(), 'ops.json');
    writeFileSync(ops, JSON.stringify([{ op: 'accept', envelope: env }]));
    for (const [point, committed] of [
      ['after_effects', false],
      ['after_commit', true],
    ] as const) {
      const r = runChild(['apply', path, ops], { CUSR_CRASH_AT: point });
      expect(r.signal, point).toBe('SIGKILL');
      const opened = openStore(path);
      if (!opened.ok) throw new Error(opened.error.detail);
      const d2 = new StoreDriver(opened.value);
      expect(counts(d2).events > before.events, point).toBe(committed);
      expect(d2.task(TASK.id).status, point).toBe(
        committed ? 'RUNNING' : 'READY',
      );
      expect(opened.value.verifyProjections().ok, point).toBe(true);
      opened.value.close();
    }
  });

  it('Scenario 3: lệnh dựa trên version cũ bị từ chối conflict, không đổi gì', () => {
    const d = new StoreDriver(openMemoryStore());
    d.must(TASK.id, { kind: 'create_task', task: TASK });
    const stale = d.task(TASK.id).version;
    d.must(TASK.id, { kind: 'start', freeze: freezeOk(TASK) });
    const before = canonicalJson([counts(d), d.task(TASK.id)]);
    expect(
      d.send(
        TASK.id,
        { kind: 'cancel', reason: 'x' },
        { expected_version: stale },
      ),
    ).toEqual({
      ok: false,
      error: { code: 'conflict', reason: 'stale_version' },
    });
    expect(canonicalJson([counts(d), d.task(TASK.id)])).toBe(before);
  });

  it('Scenario 4: dựng lại toàn bộ projection từ nhật ký nhiều task khớp 100%', () => {
    const store = openFileStoreForTest(dbPath(tmp()));
    mixedWorkload(new StoreDriver(store));
    expect(store.verifyProjections()).toMatchObject({
      ok: true,
      tasks: 3,
      mismatches: [],
    });
    store.close();
  });

  it('Scenario 5: yêu cầu lại cùng thao tác dùng lại idem_key, không tạo effect thứ hai', () => {
    const d = new StoreDriver(openMemoryStore());
    createAndStart(d, TASK);
    const prep = d.pendingOne(TASK.id, 'prepare');
    expect(d.claim(prep.id).ok).toBe(true);
    d.must(TASK.id, {
      kind: 'effect_result',
      effect_id: prep.id as Uuid,
      outcome: 'unknown',
    });
    // Đối chiếu: chưa thực thi → đưa lại vào hàng đợi với cùng khoá.
    expect(d.claim(d.pendingOne(TASK.id, 'reconcile').id).ok).toBe(true);
    d.must(TASK.id, {
      kind: 'effect_reconciled',
      effect_id: prep.id as Uuid,
      finding: 'not_executed',
    });
    const again = d.pendingOne(TASK.id, 'prepare');
    expect(again).toMatchObject({
      id: prep.id,
      idem_key: prep.idem_key,
      status: 'pending',
    });
    const n = (
      storeDb(d.store)
        .prepare('SELECT count(*) AS n FROM effects WHERE idem_key = ?')
        .get(prep.idem_key) as { n: number }
    ).n;
    expect(n).toBe(1);
    expect(d.store.verifyProjections().ok).toBe(true);
  });

  it('Scenario 6: timer đến hạn chỉ tạo một tín hiệu, kể cả khi xử lý lại sau khi tiến trình chết', () => {
    const path = dbPath(tmp());
    const d = new StoreDriver(openFileStoreForTest(path));
    createAndStart(d, TASK);
    d.store.close();
    const ops = join(tmp(), 'ops.json');
    writeFileSync(ops, JSON.stringify([{ op: 'fire', now: d.now + WALL }]));
    expect(
      runChild(['apply', path, ops], { CUSR_CRASH_AT: 'after_commit' }).signal,
    ).toBe('SIGKILL');
    // Chạy lại toàn bộ thao tác, lần này không bị ngắt.
    expect(runChild(['apply', path, ops]).status).toBe(0);

    const store = openFileStoreForTest(path);
    const fired = store
      .readEvents(TASK.id)
      .filter((e) => e.type === 'TimerFired');
    expect(fired).toHaveLength(1);
    const timerSignals = (
      storeDb(store)
        .prepare(
          `SELECT count(*) AS n FROM accepted_triggers WHERE dedup_key LIKE 'timer:%'`,
        )
        .get() as { n: number }
    ).n;
    expect(timerSignals).toBe(1);
    store.close();
  });

  describe('Scenario 7: thao tác đã thành công bên ngoài nhưng chưa ghi kết quả', () => {
    /** Effect đã claim; tiến trình chết; sau khi mở lại executor chỉ báo được `unknown`. */
    function lost(d: StoreDriver, effectId: string): number {
      expect(d.claim(effectId).ok).toBe(true);
      d.must(TASK.id, {
        kind: 'effect_result',
        effect_id: effectId as Uuid,
        outcome: 'unknown',
      });
      expect(d.task(TASK.id).wait).toMatchObject({
        reason: 'infra',
        detail: { code: 'effect_unknown', effect_id: effectId },
      });
      return d.task(TASK.id).version + 1;
    }

    function atPublish(): StoreDriver {
      const d = new StoreDriver(openMemoryStore());
      createAndStart(d, TASK);
      toPublish(d, TASK, 'head7');
      return d;
    }

    it('publish: đối chiếu đủ dữ liệu → ghi bằng chứng, đi tiếp tới create_pr', () => {
      const d = atPublish();
      const pub = d.pendingOne(TASK.id, 'publish');
      const from = lost(d, pub.id);
      d.must(TASK.id, {
        kind: 'effect_reconciled',
        effect_id: pub.id as Uuid,
        finding: 'executed_succeeded',
        data: publishData('head7'),
      });
      expect(eventTypes(d, TASK.id, from)).toEqual(
        expect.arrayContaining([
          'EffectReconciled',
          'PublishRecorded',
          'BaseRelationRecorded',
        ]),
      );
      expect(d.task(TASK.id)).toMatchObject({
        status: 'RUNNING',
        head_sha: 'head7',
      });
      expect(d.pendingOne(TASK.id, 'create_pr')).toBeDefined();
      expect(d.store.verifyProjections().ok).toBe(true);
    });

    it('publish: báo thành công nhưng thiếu base_relation → effect vẫn unknown, task chờ đối chiếu', () => {
      const d = atPublish();
      const pub = d.pendingOne(TASK.id, 'publish');
      const from = lost(d, pub.id);
      d.must(TASK.id, {
        kind: 'effect_reconciled',
        effect_id: pub.id as Uuid,
        finding: 'executed_succeeded',
        data: { head_sha: 'head7' },
      });
      expect(eventTypes(d, TASK.id, from)).toContain('ReconcileIncomplete');
      expect(d.task(TASK.id).effects[pub.id]?.status).toBe('unknown');
      expect(d.task(TASK.id).wait).toMatchObject({
        reason: 'infra',
        detail: { code: 'effect_unknown' },
      });
      expect(d.pending(TASK.id, 'create_pr')).toEqual([]);
    });

    it('create PR: đối chiếu đủ → ghi pr_ref, đi tiếp tới await_ci; thiếu pr_ref → vẫn unknown', () => {
      const d = atPublish();
      d.complete(
        TASK.id,
        d.pendingOne(TASK.id, 'publish').id,
        'succeeded',
        publishData('head7'),
      );
      const pr = d.pendingOne(TASK.id, 'create_pr');
      lost(d, pr.id);
      d.must(TASK.id, {
        kind: 'effect_reconciled',
        effect_id: pr.id as Uuid,
        finding: 'executed_succeeded',
        data: { head_sha: 'head7' },
      });
      expect(d.task(TASK.id).effects[pr.id]?.status).toBe('unknown');
      d.must(TASK.id, {
        kind: 'effect_reconciled',
        effect_id: pr.id as Uuid,
        finding: 'executed_succeeded',
        data: { pr_ref: 'acme#7', head_sha: 'head7' },
      });
      expect(d.task(TASK.id)).toMatchObject({
        status: 'RUNNING',
        pr_ref: 'acme#7',
      });
      expect(d.pendingOne(TASK.id, 'await_ci')).toBeDefined();
    });

    it('start agent: đối chiếu đủ (output đã kiểm schema, invoked, usage) → giữ chỗ thành đã dùng, sang gates; chỉ có exit code → vẫn unknown', () => {
      const d = new StoreDriver(openMemoryStore());
      createAndStart(d, TASK);
      d.complete(
        TASK.id,
        d.pendingOne(TASK.id, 'prepare').id,
        'succeeded',
        PREPARE_DATA,
      );
      const agent = d.pendingOne(TASK.id, 'start_agent');
      lost(d, agent.id);
      d.must(TASK.id, {
        kind: 'effect_reconciled',
        effect_id: agent.id as Uuid,
        finding: 'executed_succeeded',
        data: { exit_code: 0 },
      });
      expect(d.task(TASK.id).effects[agent.id]?.status).toBe('unknown');
      expect(
        d.task(TASK.id).budget.reservations[agent.reservation_id ?? '']?.status,
      ).toBe('held');

      d.must(TASK.id, {
        kind: 'effect_reconciled',
        effect_id: agent.id as Uuid,
        finding: 'executed_succeeded',
        data: agentData('done'),
      });
      const s = d.task(TASK.id);
      expect(s.effects[agent.id]?.status).toBe('succeeded');
      expect(s.budget.reservations[agent.reservation_id ?? '']?.status).toBe(
        'consumed',
      );
      expect(s.current_step).toBe('gates');
      expect(d.pendingOne(TASK.id, 'run_gates')).toBeDefined();
      expect(d.store.verifyProjections().ok).toBe(true);
    });
  });

  it('Scenario 8: khoá K của task A gửi cho task B với cùng nội dung → conflict, không trả kết quả của A', () => {
    const d = new StoreDriver(openMemoryStore());
    const A = buildTask({ id: uuidOf(201), source_key: 'cli:a' });
    const B = uuidOf(202);
    d.must(A.id, { kind: 'create_task', task: A });
    const version = d.task(A.id).version;
    d.must(
      A.id,
      { kind: 'cancel', reason: 'dừng' },
      { dedup_key: 'K', expected_version: version },
    );
    const before = counts(d);
    const r = d.send(
      B,
      { kind: 'cancel', reason: 'dừng' },
      { dedup_key: 'K', expected_version: version },
    );
    expect(r).toEqual({
      ok: false,
      error: { code: 'conflict', reason: 'request_hash_mismatch' },
    });
    expect(counts(d)).toEqual(before);
    expect(d.store.readTask(B)).toBeNull();
  });
});
